package biz

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"argonaut/internal/authz"
	"argonaut/internal/conf"
	"argonaut/internal/viewer"
	pkgargo "argonaut/pkg/argo"

	"github.com/go-kratos/kratos/v3/errors"
	"golang.org/x/sync/singleflight"
)

const (
	defaultPollInterval = 5 * time.Second
	heartbeatInterval   = 10 * time.Second
	replicaLiveness     = 45 * time.Second
)

// AuthzRepo persists grants and custom policies under one revision counter (DESIGN §4.3). Every
// write increments the revision, records an audit event and notifies the other replicas, all in one
// transaction; it returns the revision it produced.
type AuthzRepo interface {
	Snapshot(ctx context.Context) (authz.Snapshot, error)
	Revision(ctx context.Context) (int64, error)
	GetGrant(ctx context.Context, id string) (authz.Grant, error)
	CreateGrant(ctx context.Context, g authz.Grant, audit AuditEvent) (authz.Grant, int64, error)
	DeleteGrant(ctx context.Context, id string, audit AuditEvent) (int64, error)
	// DeleteGrantsOn removes every grant on one scope; it returns 0 when there were none.
	DeleteGrantsOn(ctx context.Context, resourceType, namespace, name string, audit AuditEvent) (int64, error)
	CreatePolicy(ctx context.Context, p authz.CustomPolicy, audit AuditEvent) (authz.CustomPolicy, int64, error)
	SetPolicyEnabled(ctx context.Context, id string, enabled bool, audit AuditEvent) (int64, error)
	DeletePolicy(ctx context.Context, id string, audit AuditEvent) (int64, error)
	// Listen blocks, calling onRevision for every committed change until ctx ends. It reconnects by
	// itself; missed notifications are covered by polling, never by trusting the connection.
	Listen(ctx context.Context, onRevision func(int64))
	Heartbeat(ctx context.Context, replica string, revision int64) error
	Replicas(ctx context.Context, since time.Time) ([]Replica, error)
}

// Replica reports which revision one server process has loaded.
type Replica struct {
	ID       string
	Revision int64
	SeenAt   time.Time
}

// AuthzStatus is what the permissions page shows about consistency.
type AuthzStatus struct {
	Revision   int64
	Replicas   []Replica
	LastChange *AuditEvent
}

// AuthzUsecase is the single entry point for permission decisions and their administration.
//
// Consistency (DESIGN §4.3): the database revision is the truth. Each HTTP request first calls
// EnsureFresh, which reads that one row and, if this replica's snapshot is older, reloads it before
// anything is decided — so no replica ever decides on data older than the last committed change.
// NOTIFY and polling only make the reload happen early; correctness never depends on them.
type AuthzUsecase struct {
	log       *slog.Logger
	repo      AuthzRepo
	sw        *pkgargo.ClusterSwitch
	engine    *authz.Engine
	audit     *Auditor
	replicaID string
	poll      time.Duration

	reloads singleflight.Group

	subMu       sync.Mutex
	subscribers map[int]func(int64)
	nextSub     int
}

func NewAuthzUsecase(repo AuthzRepo, engine *authz.Engine, auditor *Auditor, sw *pkgargo.ClusterSwitch, authzConf *conf.Authz, logger *slog.Logger) (*AuthzUsecase, func()) {
	poll := defaultPollInterval
	if d := authzConf.GetPollInterval(); d != nil && d.AsDuration() > 0 {
		poll = d.AsDuration()
	}
	replica := authzConf.GetReplicaId()
	if replica == "" {
		replica = os.Getenv("POD_NAME")
	}
	if replica == "" {
		host, _ := os.Hostname()
		replica = fmt.Sprintf("%s/%d", host, os.Getpid())
	}
	uc := &AuthzUsecase{
		log:         logger.With("module", "biz/authz"),
		repo:        repo,
		sw:          sw,
		engine:      engine,
		audit:       auditor,
		replicaID:   replica,
		poll:        poll,
		subscribers: map[int]func(int64){},
	}

	ctx, cancel := context.WithCancel(context.Background())
	if err := uc.reload(ctx); err != nil {
		// Not fatal: requests will retry the load and report the outage until the database answers.
		uc.log.Error("initial authorization load failed", "err", err)
	}
	go repo.Listen(ctx, func(rev int64) {
		if rev > engine.Revision() {
			_ = uc.reload(ctx)
		}
	})
	go uc.background(ctx)
	return uc, cancel
}

// background polls the revision (a backstop for lost notifications, which matters only to long-lived
// streams) and reports this replica's loaded revision.
func (uc *AuthzUsecase) background(ctx context.Context) {
	poll := time.NewTicker(uc.poll)
	beat := time.NewTicker(heartbeatInterval)
	defer poll.Stop()
	defer beat.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-poll.C:
			if rev, err := uc.repo.Revision(ctx); err == nil && rev > uc.engine.Revision() {
				_ = uc.reload(ctx)
			}
		case <-beat.C:
			uc.heartbeat(ctx)
		}
	}
}

func (uc *AuthzUsecase) heartbeat(ctx context.Context) {
	if rev := uc.engine.Revision(); rev > 0 {
		if err := uc.repo.Heartbeat(ctx, uc.replicaID, rev); err != nil {
			uc.log.Debug("authz heartbeat failed", "err", err)
		}
	}
}

// reload reads a consistent snapshot and swaps it in. Concurrent callers share one load.
func (uc *AuthzUsecase) reload(ctx context.Context) error {
	_, err, _ := uc.reloads.Do("reload", func() (any, error) {
		snap, err := uc.repo.Snapshot(context.WithoutCancel(ctx))
		if err != nil {
			return nil, err
		}
		if snap.Revision < uc.engine.Revision() {
			return nil, nil // a newer snapshot won the race
		}
		changed := snap.Revision != uc.engine.Revision()
		uc.engine.Load(snap)
		if changed {
			uc.log.Info("authorization snapshot loaded", "revision", snap.Revision, "grants", len(snap.Grants), "policies", len(snap.Policies))
			uc.heartbeat(context.WithoutCancel(ctx))
			uc.notify(snap.Revision)
		}
		return nil, nil
	})
	return err
}

// EnsureFresh makes this replica's snapshot at least as new as the committed revision, and at least
// as new as minRevision (the X-Authz-Revision the client last saw, which gives read-your-writes even
// when the write happened on another replica). It fails closed: if the revision cannot be read, the
// request is refused rather than decided on possibly stale data. Super admins are exempt, so a
// database outage cannot lock out the people who would fix it.
func (uc *AuthzUsecase) EnsureFresh(ctx context.Context, minRevision int64) error {
	if uc.engine.IsSuperAdmin(viewer.Subject(ctx)) {
		return nil
	}
	committed, err := uc.repo.Revision(ctx)
	if err != nil {
		uc.log.Error("reading authorization revision failed", "err", err)
		return errors.ServiceUnavailable("authz_unavailable", "authorization data is unavailable; try again shortly")
	}
	target := committed
	if minRevision > target {
		// A client cannot have seen a revision that was never committed; ignore anything larger.
		minRevision = target
	}
	if uc.engine.Revision() >= target && uc.engine.Revision() >= minRevision {
		return nil
	}
	if err := uc.reload(ctx); err != nil {
		uc.log.Error("reloading authorization data failed", "err", err)
		return errors.ServiceUnavailable("authz_unavailable", "authorization data is unavailable; try again shortly")
	}
	return nil
}

// Revision is the revision decisions on this replica are currently taken at.
func (uc *AuthzUsecase) Revision() int64 { return uc.engine.Revision() }

// Subscribe calls fn after every snapshot change; long-lived streams use it to re-check what they
// have sent (DESIGN §4.3, "长连接").
func (uc *AuthzUsecase) Subscribe(fn func(int64)) func() {
	uc.subMu.Lock()
	defer uc.subMu.Unlock()
	id := uc.nextSub
	uc.nextSub++
	uc.subscribers[id] = fn
	return func() {
		uc.subMu.Lock()
		defer uc.subMu.Unlock()
		delete(uc.subscribers, id)
	}
}

func (uc *AuthzUsecase) notify(rev int64) {
	uc.subMu.Lock()
	fns := make([]func(int64), 0, len(uc.subscribers))
	for _, fn := range uc.subscribers {
		fns = append(fns, fn)
	}
	uc.subMu.Unlock()
	for _, fn := range fns {
		fn(rev)
	}
}

func (uc *AuthzUsecase) subject(ctx context.Context) (string, error) {
	subject := viewer.Subject(ctx)
	if subject == "" {
		return "", errors.Unauthorized("unauthorized", "no authenticated subject")
	}
	return subject, nil
}

// readActions are never audited when refused: lists and detail pages probe them constantly.
var readActions = map[authz.Action]bool{}

func init() {
	for _, r := range authz.Roles() {
		if r.Name == authz.RoleViewer {
			for _, a := range r.Actions {
				readActions[a] = true
			}
		}
	}
}

// Require fails with 403 unless the caller may perform the action on the resource. Refused writes
// are audited with the policy that refused them.
func (uc *AuthzUsecase) Require(ctx context.Context, action authz.Action, res authz.Resource) error {
	subject, err := uc.subject(ctx)
	if err != nil {
		return err
	}
	d := uc.engine.Decide(subject, action, res)
	if d.Allowed {
		return nil
	}
	reason := "no grant allows this action on this resource"
	for _, p := range d.Policies {
		if strings.HasPrefix(p, "custom:") {
			reason = "refused by policy " + strings.TrimPrefix(p, "custom:")
		}
	}
	if !readActions[action] {
		uc.audit.Record(ctx, action, res, AuditDenied, reason, map[string]any{"policies": d.Policies}, d.Revision)
	}
	where := res.Name()
	if res.Kind() == authz.ResourceTemplate {
		where = res.Namespace + "/" + res.Template
	}
	return errors.Forbidden("forbidden", fmt.Sprintf("not permitted to %s on %s %q: %s", action, strings.ReplaceAll(res.Kind(), "_", " "), where, reason))
}

// Allow reports whether the caller may perform the action, without producing an error.
func (uc *AuthzUsecase) Allow(ctx context.Context, action authz.Action, res authz.Resource) bool {
	subject := viewer.Subject(ctx)
	return subject != "" && uc.engine.Allow(subject, action, res)
}

// Actions lists what the caller may do on a resource, for the UI.
func (uc *AuthzUsecase) Actions(ctx context.Context, res authz.Resource) ([]authz.Action, error) {
	subject, err := uc.subject(ctx)
	if err != nil {
		return nil, err
	}
	return uc.engine.Actions(subject, res), nil
}

// RequireAuthenticated establishes that there is a caller. List endpoints call this instead of
// Require: their access rule is per item.
func (uc *AuthzUsecase) RequireAuthenticated(ctx context.Context) error {
	_, err := uc.subject(ctx)
	return err
}

// Subject exposes the caller identity for services that stamp it onto Argo resources.
func (uc *AuthzUsecase) Subject(ctx context.Context) string { return viewer.Subject(ctx) }

// IsSuperAdmin reports whether the caller is a bootstrapped platform administrator.
func (uc *AuthzUsecase) IsSuperAdmin(ctx context.Context) bool {
	return uc.engine.IsSuperAdmin(viewer.Subject(ctx))
}

// Audit exposes the auditor to other usecases.
func (uc *AuthzUsecase) Audit() *Auditor { return uc.audit }

// ---- grant administration ----

// ListGrants returns the grants the caller may see: their own, plus every grant on a scope they
// administer. Super admins see everything.
func (uc *AuthzUsecase) ListGrants(ctx context.Context, filterSubject, filterNamespace, filterName string) ([]authz.Grant, error) {
	subject, err := uc.subject(ctx)
	if err != nil {
		return nil, err
	}
	out := []authz.Grant{}
	for _, g := range uc.engine.Grants() {
		if filterSubject != "" && g.Subject != filterSubject {
			continue
		}
		if filterNamespace != "" && g.Namespace != filterNamespace {
			continue
		}
		if filterName != "" && g.Name != filterName {
			continue
		}
		if g.Subject == subject || uc.engine.Allow(subject, authz.AuthzGrant, GrantResource(g)) {
			out = append(out, g)
		}
	}
	return out, nil
}

// CreateGrant issues a grant. The caller must hold authz:grant on the scope, and may not grant a role
// whose actions they do not hold there themselves.
func (uc *AuthzUsecase) CreateGrant(ctx context.Context, g authz.Grant) (authz.Grant, int64, error) {
	subject, err := uc.subject(ctx)
	if err != nil {
		return authz.Grant{}, 0, err
	}
	if err := NormalizeGrant(&g); err != nil {
		return authz.Grant{}, 0, err
	}
	res := GrantResource(g)
	if err := uc.Require(ctx, authz.AuthzGrant, res); err != nil {
		return authz.Grant{}, 0, err
	}
	if err := uc.requireCanDelegate(subject, g); err != nil {
		return authz.Grant{}, 0, err
	}
	g.CreatedBy = subject
	ev := uc.grantAudit(ctx, authz.AuthzGrant, g)
	created, rev, err := uc.repo.CreateGrant(ctx, g, ev)
	if err != nil {
		return authz.Grant{}, 0, err
	}
	// Load before answering, so the caller's next request on this replica already sees the grant.
	if err := uc.reload(ctx); err != nil {
		uc.log.Error("reload after grant failed", "err", err)
	}
	return created, rev, nil
}

func (uc *AuthzUsecase) requireCanDelegate(subject string, g authz.Grant) error {
	if uc.engine.IsSuperAdmin(subject) {
		return nil
	}
	res := GrantResource(g)
	for _, role := range authz.Roles() {
		if role.Name != g.Role {
			continue
		}
		for _, action := range role.Actions {
			if !uc.engine.Allow(subject, action, res) {
				return errors.Forbidden("forbidden", fmt.Sprintf("cannot grant role %q: you do not hold %q on this scope", g.Role, action))
			}
		}
	}
	return nil
}

// DeleteGrant revokes a grant; the caller must administer the scope it applies to.
func (uc *AuthzUsecase) DeleteGrant(ctx context.Context, id string) (int64, error) {
	if _, err := uc.subject(ctx); err != nil {
		return 0, err
	}
	existing, err := uc.repo.GetGrant(ctx, id)
	if err != nil {
		return 0, err
	}
	if err := uc.Require(ctx, authz.AuthzRevoke, GrantResource(existing)); err != nil {
		return 0, err
	}
	rev, err := uc.repo.DeleteGrant(ctx, id, uc.grantAudit(ctx, authz.AuthzRevoke, existing))
	if err != nil {
		return 0, err
	}
	if err := uc.reload(ctx); err != nil {
		uc.log.Error("reload after revoke failed", "err", err)
	}
	return rev, nil
}

func (uc *AuthzUsecase) grantAudit(ctx context.Context, action authz.Action, g authz.Grant) AuditEvent {
	res := GrantResource(g)
	return AuditEvent{
		Actor:        viewer.Subject(ctx),
		Action:       string(action),
		ResourceType: g.ResourceType,
		Namespace:    g.Namespace,
		Name:         res.Name(),
		Result:       AuditAllowed,
		Reason:       fmt.Sprintf("%s → %s on %s", g.Subject, g.Role, authz.DescribeScope(g)),
		Detail:       mustJSON(map[string]any{"subject": g.Subject, "role": g.Role, "resourceType": g.ResourceType, "namespace": g.Namespace, "name": g.Name}),
	}
}

// RevokeAllOn removes every grant on a scope whose resource was just deleted. The deletion was already
// authorized, so this is housekeeping rather than an administrative act; a failure leaves an orphan
// grant, which the permissions page lists.
func (uc *AuthzUsecase) RevokeAllOn(ctx context.Context, scope authz.Grant) {
	ev := AuditEvent{
		Actor: viewer.Subject(ctx), Action: string(authz.AuthzRevoke), ResourceType: scope.ResourceType,
		Namespace: scope.Namespace, Name: scope.Name, Result: AuditAllowed,
		Reason: "revoked with the deleted " + strings.ReplaceAll(scope.ResourceType, "_", " "),
	}
	rev, err := uc.repo.DeleteGrantsOn(context.WithoutCancel(ctx), scope.ResourceType, scope.Namespace, scope.Name, ev)
	if err != nil {
		uc.log.Error("revoking grants of a deleted resource failed; they remain as orphans", "err", err, "name", scope.Name)
		return
	}
	if rev > 0 {
		_ = uc.reload(ctx)
	}
}

// OrphanGrants lists grants on templates that no longer exist (DESIGN §4.3). They are reported, not
// deleted: a GitOps tool may briefly delete and recreate a template, and its grants should survive.
func (uc *AuthzUsecase) OrphanGrants(ctx context.Context) ([]authz.Grant, error) {
	subject, err := uc.subject(ctx)
	if err != nil {
		return nil, err
	}
	cache := uc.sw.For(ctx).Cache
	if err := cache.WaitSynced(ctx); err != nil {
		return nil, err
	}
	var out []authz.Grant
	for _, g := range uc.engine.Grants() {
		switch g.ResourceType {
		case authz.ResourceTemplate:
			if !cache.Manages(g.Namespace) {
				continue
			}
			if _, ok := cache.GetTemplate(g.Namespace, g.Name); ok {
				continue
			}
		case authz.ResourceClusterTemplate:
			if _, ok := cache.GetClusterTemplate(g.Name); ok {
				continue
			}
		default:
			continue
		}
		if g.Subject == subject || uc.engine.Allow(subject, authz.AuthzGrant, GrantResource(g)) {
			out = append(out, g)
		}
	}
	return out, nil
}

// MyPermissions returns the caller's own grants and the revision they were read at.
func (uc *AuthzUsecase) MyPermissions(ctx context.Context) (string, bool, int64, []authz.Grant, error) {
	subject, err := uc.subject(ctx)
	if err != nil {
		return "", false, 0, nil, err
	}
	var mine []authz.Grant
	for _, g := range uc.engine.Grants() {
		if g.Subject == subject {
			mine = append(mine, g)
		}
	}
	return subject, uc.engine.IsSuperAdmin(subject), uc.engine.Revision(), mine, nil
}

// Roles exposes the built-in role catalogue.
func (uc *AuthzUsecase) Roles() []authz.Role { return authz.Roles() }

// Status reports the committed revision and which replicas have loaded it.
func (uc *AuthzUsecase) Status(ctx context.Context) (AuthzStatus, error) {
	if _, err := uc.subject(ctx); err != nil {
		return AuthzStatus{}, err
	}
	rev, err := uc.repo.Revision(ctx)
	if err != nil {
		return AuthzStatus{}, err
	}
	replicas, err := uc.repo.Replicas(ctx, time.Now().Add(-replicaLiveness))
	if err != nil {
		return AuthzStatus{}, err
	}
	last, err := uc.audit.repo.Latest(ctx, []string{string(authz.AuthzGrant), string(authz.AuthzRevoke), "authz:policy"})
	if err != nil {
		return AuthzStatus{}, err
	}
	return AuthzStatus{Revision: rev, Replicas: replicas, LastChange: last}, nil
}

// ---- custom policies (global admins only) ----

func (uc *AuthzUsecase) ListPolicies(ctx context.Context) ([]authz.CustomPolicy, map[string]string, error) {
	if err := uc.Require(ctx, authz.AuthzGrant, authz.Global()); err != nil {
		return nil, nil, err
	}
	snap, err := uc.repo.Snapshot(ctx)
	if err != nil {
		return nil, nil, err
	}
	return snap.Policies, uc.engine.BrokenPolicies(), nil
}

func (uc *AuthzUsecase) CreatePolicy(ctx context.Context, p authz.CustomPolicy) (authz.CustomPolicy, int64, error) {
	if err := uc.Require(ctx, authz.AuthzGrant, authz.Global()); err != nil {
		return authz.CustomPolicy{}, 0, err
	}
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		return authz.CustomPolicy{}, 0, errors.BadRequest("invalid_argument", "a policy needs a name")
	}
	if err := authz.ValidatePolicy(p.Body); err != nil {
		return authz.CustomPolicy{}, 0, errors.BadRequest("invalid_policy", err.Error())
	}
	p.CreatedBy = viewer.Subject(ctx)
	p.Enabled = true
	created, rev, err := uc.repo.CreatePolicy(ctx, p, uc.policyAudit(ctx, "create", p.Name))
	if err != nil {
		return authz.CustomPolicy{}, 0, err
	}
	_ = uc.reload(ctx)
	return created, rev, nil
}

func (uc *AuthzUsecase) SetPolicyEnabled(ctx context.Context, id, name string, enabled bool) (int64, error) {
	if err := uc.Require(ctx, authz.AuthzGrant, authz.Global()); err != nil {
		return 0, err
	}
	verb := "disable"
	if enabled {
		verb = "enable"
	}
	rev, err := uc.repo.SetPolicyEnabled(ctx, id, enabled, uc.policyAudit(ctx, verb, name))
	if err != nil {
		return 0, err
	}
	_ = uc.reload(ctx)
	return rev, nil
}

func (uc *AuthzUsecase) DeletePolicy(ctx context.Context, id, name string) (int64, error) {
	if err := uc.Require(ctx, authz.AuthzGrant, authz.Global()); err != nil {
		return 0, err
	}
	rev, err := uc.repo.DeletePolicy(ctx, id, uc.policyAudit(ctx, "delete", name))
	if err != nil {
		return 0, err
	}
	_ = uc.reload(ctx)
	return rev, nil
}

func (uc *AuthzUsecase) policyAudit(ctx context.Context, verb, name string) AuditEvent {
	return AuditEvent{
		Actor:        viewer.Subject(ctx),
		Action:       "authz:policy",
		ResourceType: authz.ResourceGlobal,
		Name:         name,
		Result:       AuditAllowed,
		Reason:       verb + " policy " + name,
	}
}

// ---- helpers ----

// GrantResource maps a grant row onto the resource scope it applies to.
func GrantResource(g authz.Grant) authz.Resource {
	switch g.ResourceType {
	case authz.ResourceGlobal:
		return authz.Global()
	case authz.ResourceNamespace:
		return authz.Resource{Namespace: g.Namespace}
	case authz.ResourceClusterTemplate:
		return authz.Resource{ClusterTemplate: g.Name}
	}
	return authz.Resource{Namespace: g.Namespace, Template: g.Name}
}

// NormalizeGrant validates a grant request and fills defaults. A template grant on "*" is accepted
// as the older spelling of a namespace grant.
func NormalizeGrant(g *authz.Grant) error {
	if g.SubjectType == "" {
		g.SubjectType = authz.SubjectUser
	}
	if g.SubjectType != authz.SubjectUser {
		return errors.BadRequest("invalid_argument", "only user grants are supported in this version")
	}
	g.Subject = strings.TrimPrefix(strings.TrimSpace(g.Subject), "user:")
	if g.Subject == "" {
		return errors.BadRequest("invalid_argument", "subject is required")
	}
	if !authz.IsRole(g.Role) {
		return errors.BadRequest("invalid_argument", fmt.Sprintf("unknown role %q", g.Role))
	}
	if g.ResourceType == authz.ResourceTemplate && (g.Name == "" || g.Name == authz.Wildcard) {
		g.ResourceType = authz.ResourceNamespace
	}
	switch g.ResourceType {
	case authz.ResourceGlobal:
		g.Namespace, g.Name = "", ""
	case authz.ResourceNamespace:
		g.Name = ""
		if g.Namespace == "" {
			return errors.BadRequest("invalid_argument", "namespace is required")
		}
	case authz.ResourceTemplate:
		if g.Namespace == "" {
			return errors.BadRequest("invalid_argument", "namespace is required for a template grant")
		}
	case authz.ResourceClusterTemplate:
		g.Namespace = ""
		if g.Name == "" {
			return errors.BadRequest("invalid_argument", "cluster template name is required")
		}
	default:
		return errors.BadRequest("invalid_argument", fmt.Sprintf("unknown resource type %q", g.ResourceType))
	}
	return nil
}
