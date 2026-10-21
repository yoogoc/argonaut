package authz

import (
	_ "embed"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"argonaut/internal/conf"

	cedar "github.com/cedar-policy/cedar-go"
	"github.com/google/wire"
)

// ProviderSet is the authz providers.
var ProviderSet = wire.NewSet(NewEngine)

//go:embed policies/roles.cedar
var builtinPolicies []byte

// Grant binds a subject to a role on a resource scope. It mirrors one row of the grants table.
type Grant struct {
	ID          string
	SubjectType string
	Subject     string
	// ResourceType is one of ResourceGlobal, ResourceNamespace, ResourceTemplate, ResourceClusterTemplate.
	ResourceType string
	// Namespace is empty for global and cluster-template grants.
	Namespace string
	// Name is the template or cluster template name; empty for global and namespace grants.
	Name      string
	Role      string
	CreatedBy string
	CreatedAt time.Time
	// Revision is the authorization revision the grant was written at.
	Revision int64
}

// CustomPolicy is an administrator-written Cedar policy layered on the built-in role policies.
type CustomPolicy struct {
	ID          string
	Name        string
	Description string
	Body        string
	Enabled     bool
	CreatedBy   string
	CreatedAt   time.Time
	Revision    int64
}

// Snapshot is everything a decision depends on, as of one authorization revision.
type Snapshot struct {
	Revision int64
	Grants   []Grant
	Policies []CustomPolicy
}

// Resource is what an action is attempted against.
//
// Exactly one of the scope fields decides its kind: a ClusterTemplate, a Template (within Namespace),
// a bare Namespace, or — with all empty — the global scope. Labels are the labels of the concrete
// object being acted on (a workflow, a template), exposed to custom policies as resource.labels.
type Resource struct {
	Namespace       string
	Template        string
	ClusterTemplate string
	Labels          map[string]string
}

// Global is the resource scope for platform-wide actions.
func Global() Resource { return Resource{} }

// Kind names the scope for logging and auditing.
func (r Resource) Kind() string {
	switch {
	case r.ClusterTemplate != "":
		return ResourceClusterTemplate
	case r.Template != "":
		return ResourceTemplate
	case r.Namespace != "":
		return ResourceNamespace
	default:
		return ResourceGlobal
	}
}

// Name is the scope's own name: the template or cluster template, or the namespace.
func (r Resource) Name() string {
	switch r.Kind() {
	case ResourceClusterTemplate:
		return r.ClusterTemplate
	case ResourceTemplate:
		return r.Template
	case ResourceNamespace:
		return r.Namespace
	}
	return ""
}

// Decision is the outcome of one evaluation, with the policies that determined it.
type Decision struct {
	Allowed  bool
	Policies []string
	Revision int64
}

// Engine evaluates Cedar policies against an immutable snapshot of grants and custom policies. A
// snapshot is swapped wholesale on Load, so every decision sees one consistent revision.
type Engine struct {
	log                *slog.Logger
	superAdmins        map[string]struct{}
	clusterTplReadable bool
	builtins           []namedPolicy

	mu      sync.RWMutex
	current *compiled
}

type namedPolicy struct {
	id     cedar.PolicyID
	policy *cedar.Policy
}

type compiled struct {
	revision int64
	loadedAt time.Time
	policies *cedar.PolicySet
	// bySubject indexes grants for building the principal entity of a request.
	bySubject map[string][]Grant
	grants    []Grant
	custom    []CustomPolicy
	// broken lists custom policies that failed to compile and were left out.
	broken map[string]string
}

// NewEngine compiles the built-in policies. No snapshot is loaded yet: until Load is called every
// non-super-admin decision is a denial, and the usecase never decides before loading.
func NewEngine(authzConf *conf.Authz, logger *slog.Logger) (*Engine, error) {
	builtins, err := parsePolicies("roles.cedar", builtinPolicies)
	if err != nil {
		return nil, fmt.Errorf("compiling built-in authz policies: %w", err)
	}
	admins := make(map[string]struct{}, len(authzConf.GetSuperAdmins()))
	for _, a := range authzConf.GetSuperAdmins() {
		if subject := normalizeSubject(a); subject != "" {
			admins[subject] = struct{}{}
		}
	}
	readable := true
	if authzConf.ClusterTemplatesReadable != nil {
		readable = authzConf.GetClusterTemplatesReadable()
	}
	e := &Engine{
		log:                logger.With("module", "authz"),
		superAdmins:        admins,
		clusterTplReadable: readable,
		builtins:           builtins,
	}
	e.log.Info("authz engine ready", "superAdmins", len(admins), "clusterTemplatesReadable", readable)
	return e, nil
}

// parsePolicies reads a Cedar document, keeping each policy's @id annotation as its id.
func parsePolicies(file string, doc []byte) ([]namedPolicy, error) {
	list, err := cedar.NewPolicyListFromBytes(file, doc)
	if err != nil {
		return nil, err
	}
	out := make([]namedPolicy, 0, len(list))
	for i, p := range list {
		id := cedar.PolicyID(fmt.Sprintf("%s#%d", file, i))
		if v, ok := p.Annotations()["id"]; ok && v != "" {
			id = cedar.PolicyID(v)
		}
		out = append(out, namedPolicy{id: id, policy: p})
	}
	return out, nil
}

// ValidatePolicy checks a custom policy body compiles, so a broken policy is refused when it is
// written rather than silently skipped when it is loaded.
func ValidatePolicy(body string) error {
	list, err := cedar.NewPolicyListFromBytes("custom.cedar", []byte(body))
	if err != nil {
		return err
	}
	if len(list) == 0 {
		return fmt.Errorf("the policy body contains no policy")
	}
	return nil
}

// Load replaces the snapshot. Custom policies that fail to compile are skipped and reported in the
// log rather than failing the load: one broken policy must not take every decision down with it.
func (e *Engine) Load(s Snapshot) {
	ps := cedar.NewPolicySet()
	for _, p := range e.builtins {
		ps.Add(p.id, p.policy)
	}
	broken := map[string]string{}
	for _, cp := range s.Policies {
		if !cp.Enabled {
			continue
		}
		parsed, err := parsePolicies(cp.Name, []byte(cp.Body))
		if err != nil {
			broken[cp.Name] = err.Error()
			e.log.Error("custom authz policy does not compile; skipped", "policy", cp.Name, "err", err)
			continue
		}
		for i, p := range parsed {
			id := cedar.PolicyID("custom:" + cp.Name)
			if len(parsed) > 1 {
				id = cedar.PolicyID(fmt.Sprintf("custom:%s#%d", cp.Name, i))
			}
			ps.Add(id, p.policy)
		}
	}
	bySubject := make(map[string][]Grant)
	for _, g := range s.Grants {
		bySubject[g.Subject] = append(bySubject[g.Subject], g)
	}
	next := &compiled{
		revision:  s.Revision,
		loadedAt:  time.Now(),
		policies:  ps,
		bySubject: bySubject,
		grants:    s.Grants,
		custom:    s.Policies,
		broken:    broken,
	}
	e.mu.Lock()
	e.current = next
	e.mu.Unlock()
	e.log.Debug("authz snapshot loaded", "revision", s.Revision, "grants", len(s.Grants), "policies", len(s.Policies))
}

// Revision reports the loaded revision; zero means nothing has been loaded.
func (e *Engine) Revision() int64 {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.current == nil {
		return 0
	}
	return e.current.revision
}

// LoadedAt reports when the snapshot was loaded.
func (e *Engine) LoadedAt() time.Time {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.current == nil {
		return time.Time{}
	}
	return e.current.loadedAt
}

// IsSuperAdmin reports whether the subject is bootstrapped as a platform administrator.
func (e *Engine) IsSuperAdmin(subject string) bool {
	_, ok := e.superAdmins[subject]
	return ok
}

// Grants returns the loaded grant table.
func (e *Engine) Grants() []Grant {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.current == nil {
		return nil
	}
	return append([]Grant(nil), e.current.grants...)
}

// BrokenPolicies returns custom policies that failed to compile in the loaded snapshot.
func (e *Engine) BrokenPolicies() map[string]string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.current == nil {
		return nil
	}
	return e.current.broken
}

// Decide evaluates one request.
func (e *Engine) Decide(subject string, action Action, res Resource) Decision {
	if subject == "" {
		return Decision{}
	}
	if e.IsSuperAdmin(subject) {
		return Decision{Allowed: true, Policies: []string{"super-admin"}, Revision: e.Revision()}
	}
	e.mu.RLock()
	snap := e.current
	e.mu.RUnlock()
	if snap == nil {
		return Decision{}
	}

	principal := cedar.NewEntityUID("User", cedar.String(subject))
	resourceUID, resourceEntity := resourceEntity(res)
	entities := cedar.EntityMap{
		principal:   {UID: principal, Parents: groupsOf(snap.bySubject[subject])},
		resourceUID: resourceEntity,
	}
	for uid, ent := range actionEntities {
		entities[uid] = ent
	}
	req := cedar.Request{
		Principal: principal,
		Action:    actionUID(string(action)),
		Resource:  resourceUID,
		Context:   cedar.NewRecord(cedar.RecordMap{"clusterTemplatesReadable": cedar.Boolean(e.clusterTplReadable)}),
	}
	decision, diag := cedar.Authorize(snap.policies, entities, req)
	out := Decision{Allowed: decision == cedar.Allow, Revision: snap.revision}
	for _, r := range diag.Reasons {
		out.Policies = append(out.Policies, string(r.PolicyID))
	}
	for _, de := range diag.Errors {
		e.log.Debug("authz policy evaluation error", "policy", de.PolicyID, "err", de.Message)
	}
	return out
}

// Allow reports whether the subject may perform the action on the resource.
func (e *Engine) Allow(subject string, action Action, res Resource) bool {
	return e.Decide(subject, action, res).Allowed
}

// Actions lists every action the subject may perform on the resource; the UI shows buttons from it.
func (e *Engine) Actions(subject string, res Resource) []Action {
	var out []Action
	for _, a := range AllActions() {
		if e.Allow(subject, a, res) {
			out = append(out, a)
		}
	}
	return out
}

// ---- entities ----

const (
	scopeGlobal = "global"
)

func scopeKey(resourceType, namespace, name string) string {
	switch resourceType {
	case ResourceGlobal:
		return scopeGlobal
	case ResourceNamespace:
		return "ns:" + namespace
	case ResourceTemplate:
		return "tpl:" + namespace + "/" + name
	case ResourceClusterTemplate:
		return "ctpl:" + name
	}
	return "invalid:" + resourceType
}

func groupUID(scope, role string) cedar.EntityUID {
	return cedar.NewEntityUID("Group", cedar.String(scope+"#"+role))
}

// groupsOf turns a user's grants into role-group memberships.
func groupsOf(grants []Grant) cedar.EntityUIDSet {
	uids := make([]cedar.EntityUID, 0, len(grants))
	for _, g := range grants {
		uids = append(uids, groupUID(scopeKey(g.ResourceType, g.Namespace, g.Name), g.Role))
	}
	return cedar.NewEntityUIDSet(uids...)
}

// coveringScopes lists the scopes whose grants apply to a resource, broadest first.
func coveringScopes(res Resource) []string {
	switch res.Kind() {
	case ResourceClusterTemplate:
		return []string{scopeGlobal, scopeKey(ResourceClusterTemplate, "", res.ClusterTemplate)}
	case ResourceTemplate:
		return []string{scopeGlobal, scopeKey(ResourceNamespace, res.Namespace, ""), scopeKey(ResourceTemplate, res.Namespace, res.Template)}
	case ResourceNamespace:
		return []string{scopeGlobal, scopeKey(ResourceNamespace, res.Namespace, "")}
	}
	return []string{scopeGlobal}
}

func resourceEntity(res Resource) (cedar.EntityUID, cedar.Entity) {
	var uid cedar.EntityUID
	switch res.Kind() {
	case ResourceClusterTemplate:
		uid = cedar.NewEntityUID("ClusterTemplate", cedar.String(res.ClusterTemplate))
	case ResourceTemplate:
		uid = cedar.NewEntityUID("Template", cedar.String(res.Namespace+"/"+res.Template))
	case ResourceNamespace:
		uid = cedar.NewEntityUID("Namespace", cedar.String(res.Namespace))
	default:
		uid = cedar.NewEntityUID("Global", cedar.String(scopeGlobal))
	}
	scopes := coveringScopes(res)
	roleSet := func(role string) cedar.Set {
		values := make([]cedar.Value, 0, len(scopes))
		for _, s := range scopes {
			values = append(values, groupUID(s, role))
		}
		return cedar.NewSet(values...)
	}
	labels := cedar.RecordMap{}
	keys := make([]string, 0, len(res.Labels))
	for k := range res.Labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		labels[cedar.String(k)] = cedar.String(res.Labels[k])
	}
	attrs := cedar.RecordMap{
		"kind":      cedar.String(res.Kind()),
		"namespace": cedar.String(res.Namespace),
		"name":      cedar.String(res.Name()),
		"labels":    cedar.NewRecord(labels),
		"viewers":   roleSet(RoleViewer),
		"operators": roleSet(RoleOperator),
		"editors":   roleSet(RoleEditor),
		"admins":    roleSet(RoleAdmin),
	}
	return uid, cedar.Entity{UID: uid, Attributes: cedar.NewRecord(attrs)}
}

func actionUID(id string) cedar.EntityUID {
	return cedar.NewEntityUID("Action", cedar.String(id))
}

// actionEntities is the action hierarchy: each action belongs to the narrowest role that grants it,
// and each role group belongs to the next wider role, so `action in Action::"role:operator"` covers
// viewer actions too.
var actionEntities = func() cedar.EntityMap {
	m := cedar.EntityMap{}
	for i, role := range roleOrder {
		roleUID := actionUID("role:" + role)
		var parents []cedar.EntityUID
		if i+1 < len(roleOrder) {
			parents = append(parents, actionUID("role:"+roleOrder[i+1]))
		}
		m[roleUID] = cedar.Entity{UID: roleUID, Parents: cedar.NewEntityUIDSet(parents...)}
		for _, a := range ownActions[role] {
			uid := actionUID(string(a))
			m[uid] = cedar.Entity{UID: uid, Parents: cedar.NewEntityUIDSet(roleUID)}
		}
	}
	return m
}()

// DescribeScope renders a grant scope for messages.
func DescribeScope(g Grant) string {
	switch g.ResourceType {
	case ResourceGlobal:
		return "global"
	case ResourceNamespace:
		return "namespace " + g.Namespace
	case ResourceClusterTemplate:
		return "cluster template " + g.Name
	}
	return "template " + strings.TrimPrefix(g.Namespace+"/"+g.Name, "/")
}
