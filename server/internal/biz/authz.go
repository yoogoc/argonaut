package biz

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"argonaut/internal/authz"
	"argonaut/internal/conf"
	"argonaut/internal/viewer"

	"github.com/go-kratos/kratos/v3/errors"
)

const defaultReloadInterval = 15 * time.Second

// GrantRepo persists authorization grants.
type GrantRepo interface {
	List(ctx context.Context) ([]authz.Grant, error)
	ListBySubject(ctx context.Context, subject string) ([]authz.Grant, error)
	Get(ctx context.Context, id string) (authz.Grant, error)
	Create(ctx context.Context, g authz.Grant) (authz.Grant, error)
	Delete(ctx context.Context, id string) error
}

// AuthzUsecase is the single entry point for permission decisions and grant administration. Service
// methods call Require before doing any work, and Filter* to drop resources the caller can't see.
type AuthzUsecase struct {
	log    *slog.Logger
	repo   GrantRepo
	engine *authz.Engine

	reloadInterval time.Duration
	reloadMu       sync.Mutex
}

func NewAuthzUsecase(repo GrantRepo, engine *authz.Engine, authzConf *conf.Authz, logger *slog.Logger) *AuthzUsecase {
	interval := defaultReloadInterval
	if d := authzConf.GetReloadInterval(); d != nil && d.AsDuration() > 0 {
		interval = d.AsDuration()
	}
	return &AuthzUsecase{
		log:            logger.With("module", "biz/authz"),
		repo:           repo,
		engine:         engine,
		reloadInterval: interval,
	}
}

// ensureFresh reloads the grant table when it has gone stale. Another replica may have changed
// permissions, and there is no cross-replica invalidation, so freshness is bounded by this interval.
func (uc *AuthzUsecase) ensureFresh(ctx context.Context) error {
	// A super admin is defined entirely by configuration, so their access must not depend on the
	// database being reachable — otherwise a database outage locks out the only people who could
	// repair the deployment.
	if uc.engine.IsSuperAdmin(viewer.Subject(ctx)) {
		return nil
	}
	if uc.fresh() {
		return nil
	}
	uc.reloadMu.Lock()
	defer uc.reloadMu.Unlock()
	// Re-check: a concurrent caller may have reloaded while we waited for the lock.
	if uc.fresh() {
		return nil
	}
	return uc.reload(ctx)
}

// fresh reports whether the loaded grant table can still be trusted. A never-loaded table is not
// fresh no matter how recently the process started, otherwise every restart would deny all
// non-super-admin access until the first interval elapsed.
func (uc *AuthzUsecase) fresh() bool {
	loadedAt := uc.engine.LoadedAt()
	return !loadedAt.IsZero() && time.Since(loadedAt) < uc.reloadInterval
}

func (uc *AuthzUsecase) reload(ctx context.Context) error {
	grants, err := uc.repo.List(ctx)
	if err != nil {
		return fmt.Errorf("loading grants: %w", err)
	}
	return uc.engine.Reload(ctx, grants)
}

// Require fails with 403 unless the caller may perform the action on the resource.
func (uc *AuthzUsecase) Require(ctx context.Context, action authz.Action, res authz.Resource) error {
	subject, err := uc.subject(ctx)
	if err != nil {
		return err
	}
	if err := uc.ensureFresh(ctx); err != nil {
		return err
	}
	return uc.engine.Require(ctx, subject, action, res)
}

// Allow reports whether the caller may perform the action, without producing an error.
func (uc *AuthzUsecase) Allow(ctx context.Context, action authz.Action, res authz.Resource) bool {
	subject, err := uc.subject(ctx)
	if err != nil {
		return false
	}
	if err := uc.ensureFresh(ctx); err != nil {
		uc.log.Error("failed to refresh grants", "err", err)
		return false
	}
	allowed, err := uc.engine.Allow(ctx, subject, action, res)
	if err != nil {
		uc.log.Error("authz evaluation failed", "err", err)
		return false
	}
	return allowed
}

func (uc *AuthzUsecase) subject(ctx context.Context) (string, error) {
	subject := viewer.Subject(ctx)
	if subject == "" {
		return "", errors.Unauthorized("unauthorized", "no authenticated subject")
	}
	return subject, nil
}

// RequireAuthenticated establishes that there is a caller and that the grant table is loaded.
//
// List endpoints call this instead of Require: their access rule is per item, since someone holding a
// grant on a single template must still be able to open the list page and see that one template.
// Both failures it reports would otherwise surface as an empty list — indistinguishable from "nothing
// exists" — so they are turned into errors here: 401 when nobody is authenticated, and the loading
// error when permissions cannot be read at all.
func (uc *AuthzUsecase) RequireAuthenticated(ctx context.Context) error {
	if _, err := uc.subject(ctx); err != nil {
		return err
	}
	return uc.ensureFresh(ctx)
}

// Subject exposes the caller identity for services that stamp it onto Argo resources.
func (uc *AuthzUsecase) Subject(ctx context.Context) string {
	return viewer.Subject(ctx)
}

// IsSuperAdmin reports whether the caller is a bootstrapped platform administrator.
func (uc *AuthzUsecase) IsSuperAdmin(ctx context.Context) bool {
	return uc.engine.IsSuperAdmin(viewer.Subject(ctx))
}

// ListGrants returns grants the caller is allowed to see: their own always, plus every grant on a
// scope they administer. Super admins see everything.
func (uc *AuthzUsecase) ListGrants(ctx context.Context, filterSubject, filterNamespace, filterName string) ([]authz.Grant, error) {
	subject, err := uc.subject(ctx)
	if err != nil {
		return nil, err
	}
	if err := uc.reloadNow(ctx); err != nil {
		return nil, err
	}

	all, err := uc.repo.List(ctx)
	if err != nil {
		return nil, err
	}

	out := make([]authz.Grant, 0, len(all))
	for _, g := range all {
		if filterSubject != "" && g.Subject != filterSubject {
			continue
		}
		if filterNamespace != "" && g.Namespace != filterNamespace {
			continue
		}
		if filterName != "" && g.Name != filterName {
			continue
		}
		if g.Subject == subject {
			out = append(out, g)
			continue
		}
		// Seeing someone else's grant requires administering the scope it applies to.
		if allowed, _ := uc.engine.Allow(ctx, subject, authz.AuthzGrant, grantResource(g)); allowed {
			out = append(out, g)
		}
	}
	return out, nil
}

// CreateGrant issues a grant. The caller must hold authz:grant on the scope being granted, which is
// what makes "who may authorize whom" part of the same policy as everything else.
func (uc *AuthzUsecase) CreateGrant(ctx context.Context, g authz.Grant) (authz.Grant, error) {
	subject, err := uc.subject(ctx)
	if err != nil {
		return authz.Grant{}, err
	}
	if err := normalizeGrant(&g); err != nil {
		return authz.Grant{}, err
	}
	if err := uc.Require(ctx, authz.AuthzGrant, grantResource(g)); err != nil {
		return authz.Grant{}, err
	}
	// A grant may not exceed what the issuer can already do, otherwise a template admin could mint
	// themselves global powers.
	if err := uc.requireCanDelegate(ctx, subject, g); err != nil {
		return authz.Grant{}, err
	}

	g.CreatedBy = subject
	created, err := uc.repo.Create(ctx, g)
	if err != nil {
		return authz.Grant{}, err
	}
	if err := uc.reload(ctx); err != nil {
		return authz.Grant{}, err
	}
	uc.log.Info("grant created", "by", subject, "subject", g.Subject, "role", g.Role,
		"namespace", g.Namespace, "name", g.Name, "resourceType", g.ResourceType)
	return created, nil
}

// requireCanDelegate checks the issuer holds every action the new role confers on that scope.
func (uc *AuthzUsecase) requireCanDelegate(ctx context.Context, subject string, g authz.Grant) error {
	if uc.engine.IsSuperAdmin(subject) {
		return nil
	}
	res := grantResource(g)
	for _, role := range authz.Roles() {
		if role.Name != g.Role {
			continue
		}
		for _, action := range role.Actions {
			allowed, err := uc.engine.Allow(ctx, subject, action, res)
			if err != nil {
				return err
			}
			if !allowed {
				return errors.Forbidden("forbidden",
					fmt.Sprintf("cannot grant role %q: you do not hold %q on this scope", g.Role, action))
			}
		}
	}
	return nil
}

// DeleteGrant revokes a grant; the caller must administer the scope it applies to.
func (uc *AuthzUsecase) DeleteGrant(ctx context.Context, id string) error {
	subject, err := uc.subject(ctx)
	if err != nil {
		return err
	}
	existing, err := uc.repo.Get(ctx, id)
	if err != nil {
		return err
	}
	if err := uc.Require(ctx, authz.AuthzRevoke, grantResource(existing)); err != nil {
		return err
	}
	if err := uc.repo.Delete(ctx, id); err != nil {
		return err
	}
	if err := uc.reload(ctx); err != nil {
		return err
	}
	uc.log.Info("grant deleted", "by", subject, "id", id, "subject", existing.Subject, "role", existing.Role)
	return nil
}

// MyPermissions returns the caller's own grants so the UI can hide actions it would be refused.
func (uc *AuthzUsecase) MyPermissions(ctx context.Context) (string, bool, []authz.Grant, error) {
	subject, err := uc.subject(ctx)
	if err != nil {
		return "", false, nil, err
	}
	if err := uc.reloadNow(ctx); err != nil {
		return "", false, nil, err
	}
	grants, err := uc.repo.ListBySubject(ctx, subject)
	if err != nil {
		return "", false, nil, err
	}
	return subject, uc.engine.IsSuperAdmin(subject), grants, nil
}

// reloadNow refreshes unconditionally, for reads that must not show stale permissions.
func (uc *AuthzUsecase) reloadNow(ctx context.Context) error {
	uc.reloadMu.Lock()
	defer uc.reloadMu.Unlock()
	return uc.reload(ctx)
}

// Roles exposes the built-in role catalogue.
func (uc *AuthzUsecase) Roles() []authz.Role {
	return authz.Roles()
}

// grantResource maps a grant row onto the resource scope it applies to.
func grantResource(g authz.Grant) authz.Resource {
	if g.ResourceType == authz.ResourceGlobal {
		return authz.Global()
	}
	if g.Name == authz.Wildcard {
		// A namespace-wide grant is administered at namespace level, so the template is left empty.
		return authz.Resource{Namespace: g.Namespace}
	}
	return authz.Resource{Namespace: g.Namespace, Template: g.Name}
}

func normalizeGrant(g *authz.Grant) error {
	if g.SubjectType == "" {
		g.SubjectType = authz.SubjectUser
	}
	if g.SubjectType != authz.SubjectUser {
		// Group grants need the identity provider decision (and a groups claim) first.
		return errors.BadRequest("invalid_argument", fmt.Sprintf("unsupported subject type %q", g.SubjectType))
	}
	if g.Subject == "" {
		return errors.BadRequest("invalid_argument", "subject is required")
	}
	if !authz.IsRole(g.Role) {
		return errors.BadRequest("invalid_argument", fmt.Sprintf("unknown role %q", g.Role))
	}
	switch g.ResourceType {
	case "":
		g.ResourceType = authz.ResourceTemplate
	case authz.ResourceTemplate, authz.ResourceGlobal:
	default:
		return errors.BadRequest("invalid_argument", fmt.Sprintf("unknown resource type %q", g.ResourceType))
	}
	if g.ResourceType == authz.ResourceGlobal {
		g.Namespace = ""
		g.Name = authz.Wildcard
		return nil
	}
	if g.Namespace == "" {
		return errors.BadRequest("invalid_argument", "namespace is required for a template grant")
	}
	if g.Name == "" {
		g.Name = authz.Wildcard
	}
	return nil
}
