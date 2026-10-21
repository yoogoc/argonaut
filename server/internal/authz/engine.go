package authz

import (
	"context"
	_ "embed"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"argonaut/internal/conf"

	"github.com/go-kratos/kratos/v3/errors"
	"github.com/google/wire"
	"github.com/open-policy-agent/opa/v1/rego"
	"github.com/open-policy-agent/opa/v1/storage/inmem"
)

// ProviderSet is the authz providers.
var ProviderSet = wire.NewSet(NewEngine)

//go:embed policy.rego
var defaultPolicy string

const (
	policyPackage  = "argonaut.authz"
	allowQuery     = "data.argonaut.authz.allow"
	rolesQuery     = "data.argonaut.authz.effective_roles"
	defaultTimeout = 5 * time.Second
)

// Grant binds a subject to a role on a resource scope. It mirrors one row of the grants table.
type Grant struct {
	ID          string
	SubjectType string
	Subject     string
	// ResourceType is ResourceTemplate or ResourceGlobal.
	ResourceType string
	Namespace    string
	// Name is a template name or Wildcard.
	Name      string
	Role      string
	CreatedBy string
	CreatedAt time.Time
}

// Resource is what an action is attempted against. Template is the WorkflowTemplate a workflow or
// cron workflow derives from; it is empty for resources with no template lineage, which then only
// match namespace-wide grants.
type Resource struct {
	Namespace string
	Template  string
}

// Global is the resource scope for platform-wide actions.
func Global() Resource { return Resource{} }

// Engine evaluates the rego policy. Grants live in OPA's in-memory store and are swapped wholesale
// on reload: the table is small (one row per grant), so a full refresh is simpler and cheaper than
// incremental updates, and it keeps the store consistent with the database at all times.
type Engine struct {
	log         *slog.Logger
	superAdmins []string
	policy      string

	mu         sync.RWMutex
	allow      *rego.PreparedEvalQuery
	roles      *rego.PreparedEvalQuery
	grants     []Grant
	loadedAt   time.Time
	adminIndex map[string]struct{}
}

// NewEngine compiles the policy. The grant table starts empty; Reload fills it from the database.
func NewEngine(authzConf *conf.Authz, logger *slog.Logger) (*Engine, error) {
	policy := defaultPolicy
	if path := authzConf.GetPolicyPath(); path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("reading authz policy %s: %w", path, err)
		}
		policy = string(raw)
	}

	admins := make([]string, 0, len(authzConf.GetSuperAdmins()))
	adminIndex := make(map[string]struct{}, len(authzConf.GetSuperAdmins()))
	for _, a := range authzConf.GetSuperAdmins() {
		subject := normalizeSubject(a)
		if subject == "" {
			continue
		}
		admins = append(admins, subject)
		adminIndex[subject] = struct{}{}
	}

	e := &Engine{
		log:         logger.With("module", "authz"),
		superAdmins: admins,
		policy:      policy,
		adminIndex:  adminIndex,
	}
	// Compile the policy now so a syntax error fails startup rather than the first request. The grant
	// table stays empty and loadedAt stays zero, which marks it as never loaded: callers must read the
	// grants from the database before trusting a decision. Treating the empty table as merely "fresh"
	// would deny everyone for one reload interval after every restart.
	if err := e.compile(context.Background(), nil); err != nil {
		return nil, err
	}
	e.log.Info("authz engine ready", "superAdmins", len(admins))
	return e, nil
}

// Reload republishes the grant table into OPA and marks it loaded.
func (e *Engine) Reload(ctx context.Context, grants []Grant) error {
	if err := e.compile(ctx, grants); err != nil {
		return err
	}
	e.mu.Lock()
	e.loadedAt = time.Now()
	e.mu.Unlock()

	e.log.Debug("authz grants reloaded", "grants", len(grants))
	return nil
}

// compile rebuilds the OPA store and the prepared queries over a grant table.
func (e *Engine) compile(ctx context.Context, grants []Grant) error {
	store := inmem.NewFromObject(map[string]any{
		"grants":       grantData(grants),
		"roles":        roleData(),
		"super_admins": e.superAdmins,
	})

	allow, err := rego.New(
		rego.Query(allowQuery),
		rego.Module(policyPackage+".rego", e.policy),
		rego.Store(store),
	).PrepareForEval(ctx)
	if err != nil {
		return fmt.Errorf("compiling authz policy: %w", err)
	}
	roles, err := rego.New(
		rego.Query(rolesQuery),
		rego.Module(policyPackage+".rego", e.policy),
		rego.Store(store),
	).PrepareForEval(ctx)
	if err != nil {
		return fmt.Errorf("compiling authz roles query: %w", err)
	}

	e.mu.Lock()
	e.allow = &allow
	e.roles = &roles
	e.grants = grants
	e.mu.Unlock()
	return nil
}

// grantData renders grants with the snake_case keys the policy reads.
func grantData(grants []Grant) []map[string]any {
	out := make([]map[string]any, 0, len(grants))
	for _, g := range grants {
		out = append(out, map[string]any{
			"subject":       g.Subject,
			"subject_type":  g.SubjectType,
			"resource_type": g.ResourceType,
			"namespace":     g.Namespace,
			"name":          g.Name,
			"role":          g.Role,
		})
	}
	return out
}

// Allow reports whether the subject may perform the action on the resource.
func (e *Engine) Allow(ctx context.Context, subject string, action Action, res Resource) (bool, error) {
	if subject == "" {
		return false, nil
	}
	e.mu.RLock()
	query := e.allow
	e.mu.RUnlock()
	if query == nil {
		return false, fmt.Errorf("authz engine not initialised")
	}

	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	rs, err := query.Eval(ctx, rego.EvalInput(map[string]any{
		"subject": subject,
		"action":  string(action),
		"resource": map[string]any{
			"namespace": res.Namespace,
			"template":  res.Template,
		},
	}))
	if err != nil {
		return false, fmt.Errorf("evaluating authz policy: %w", err)
	}
	if len(rs) == 0 || len(rs[0].Expressions) == 0 {
		return false, nil
	}
	allowed, _ := rs[0].Expressions[0].Value.(bool)
	return allowed, nil
}

// Require returns a Kratos 403 unless the action is permitted. Services call this before doing work.
func (e *Engine) Require(ctx context.Context, subject string, action Action, res Resource) error {
	allowed, err := e.Allow(ctx, subject, action, res)
	if err != nil {
		return err
	}
	if !allowed {
		return errors.Forbidden("forbidden", fmt.Sprintf("not permitted to %s in namespace %q", action, res.Namespace))
	}
	return nil
}

// EffectiveRoles lists the roles the subject holds on a resource, for the UI's permission view.
func (e *Engine) EffectiveRoles(ctx context.Context, subject string, res Resource) ([]string, error) {
	e.mu.RLock()
	query := e.roles
	e.mu.RUnlock()
	if query == nil {
		return nil, fmt.Errorf("authz engine not initialised")
	}

	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	rs, err := query.Eval(ctx, rego.EvalInput(map[string]any{
		"subject": subject,
		"action":  "",
		"resource": map[string]any{
			"namespace": res.Namespace,
			"template":  res.Template,
		},
	}))
	if err != nil {
		return nil, fmt.Errorf("evaluating effective roles: %w", err)
	}
	if len(rs) == 0 || len(rs[0].Expressions) == 0 {
		return nil, nil
	}
	values, _ := rs[0].Expressions[0].Value.([]any)
	roles := make([]string, 0, len(values))
	for _, v := range values {
		if s, ok := v.(string); ok {
			roles = append(roles, s)
		}
	}
	return roles, nil
}

// IsSuperAdmin reports whether the subject is bootstrapped as a platform administrator.
func (e *Engine) IsSuperAdmin(subject string) bool {
	_, ok := e.adminIndex[subject]
	return ok
}

// Grants returns the currently loaded grant table.
func (e *Engine) Grants() []Grant {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make([]Grant, len(e.grants))
	copy(out, e.grants)
	return out
}

// LoadedAt reports when the grant table was last read from storage. The zero value means it never
// has been, which callers must treat as stale rather than as an empty set of permissions.
func (e *Engine) LoadedAt() time.Time {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.loadedAt
}
