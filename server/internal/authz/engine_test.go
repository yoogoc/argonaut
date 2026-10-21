package authz

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"argonaut/internal/conf"
)

func newTestEngine(t *testing.T, superAdmins []string, grants []Grant) *Engine {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	e, err := NewEngine(&conf.Authz{SuperAdmins: superAdmins}, logger)
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}
	if err := e.Reload(context.Background(), grants); err != nil {
		t.Fatalf("Reload: %v", err)
	}
	return e
}

func TestAllow(t *testing.T) {
	grants := []Grant{
		// A viewer on one specific template.
		{Subject: "alice", SubjectType: SubjectUser, ResourceType: ResourceTemplate, Namespace: "argo", Name: "build", Role: RoleViewer},
		// An operator across a whole namespace.
		{Subject: "bob", SubjectType: SubjectUser, ResourceType: ResourceTemplate, Namespace: "argo", Name: Wildcard, Role: RoleOperator},
		// An admin on one template: may grant there, but nowhere else.
		{Subject: "carol", SubjectType: SubjectUser, ResourceType: ResourceTemplate, Namespace: "argo", Name: "build", Role: RoleAdmin},
	}
	e := newTestEngine(t, []string{"user:root"}, grants)

	cases := []struct {
		name    string
		subject string
		action  Action
		res     Resource
		want    bool
	}{
		{"viewer reads its template", "alice", TemplateGet, Resource{"argo", "build"}, true},
		{"viewer cannot retry", "alice", WorkflowRetry, Resource{"argo", "build"}, false},
		{"viewer cannot read another template", "alice", TemplateGet, Resource{"argo", "deploy"}, false},
		{"viewer cannot cross namespaces", "alice", TemplateGet, Resource{"prod", "build"}, false},

		{"namespace operator retries any template", "bob", WorkflowRetry, Resource{"argo", "deploy"}, true},
		{"namespace grant covers template-less workflows", "bob", WorkflowRetry, Resource{Namespace: "argo"}, true},
		{"operator cannot edit templates", "bob", TemplateUpdate, Resource{"argo", "deploy"}, false},
		{"operator cannot grant", "bob", AuthzGrant, Resource{"argo", "deploy"}, false},
		{"namespace grant does not leak to other namespaces", "bob", WorkflowRetry, Resource{"prod", "deploy"}, false},

		{"admin may grant on its scope", "carol", AuthzGrant, Resource{"argo", "build"}, true},
		{"admin may not grant elsewhere", "carol", AuthzGrant, Resource{"argo", "deploy"}, false},
		{"admin inherits editor actions", "carol", TemplateUpdate, Resource{"argo", "build"}, true},

		{"super admin may do anything", "root", AuthzGrant, Resource{"prod", "anything"}, true},
		{"super admin is namespace agnostic", "root", WorkflowDelete, Resource{Namespace: "whatever"}, true},

		{"unknown subject is denied", "mallory", TemplateList, Resource{"argo", "build"}, false},
		{"empty subject is denied", "", TemplateList, Resource{"argo", "build"}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := e.Allow(context.Background(), tc.subject, tc.action, tc.res)
			if err != nil {
				t.Fatalf("Allow: %v", err)
			}
			if got != tc.want {
				t.Errorf("Allow(%q, %q, %+v) = %v, want %v", tc.subject, tc.action, tc.res, got, tc.want)
			}
		})
	}
}

// A template-less workflow must not become visible just because someone holds a grant on a single
// template in that namespace: only namespace-wide grants cover it.
func TestTemplatelessWorkflowNeedsNamespaceGrant(t *testing.T) {
	e := newTestEngine(t, nil, []Grant{
		{Subject: "alice", ResourceType: ResourceTemplate, Namespace: "argo", Name: "build", Role: RoleViewer},
	})
	got, err := e.Allow(context.Background(), "alice", WorkflowGet, Resource{Namespace: "argo"})
	if err != nil {
		t.Fatalf("Allow: %v", err)
	}
	if got {
		t.Error("a single-template grant must not cover workflows with no template lineage")
	}
}

func TestGlobalGrant(t *testing.T) {
	e := newTestEngine(t, nil, []Grant{
		{Subject: "dave", ResourceType: ResourceGlobal, Role: RoleEditor},
	})
	for _, res := range []Resource{{"argo", "build"}, {"prod", "deploy"}, {}} {
		got, err := e.Allow(context.Background(), "dave", TemplateCreate, res)
		if err != nil {
			t.Fatalf("Allow: %v", err)
		}
		if !got {
			t.Errorf("global editor grant should cover %+v", res)
		}
	}
	// A global editor still cannot grant permissions; that needs admin.
	got, err := e.Allow(context.Background(), "dave", AuthzGrant, Resource{"argo", "build"})
	if err != nil {
		t.Fatalf("Allow: %v", err)
	}
	if got {
		t.Error("editor must not have authz:grant")
	}
}

func TestEffectiveRoles(t *testing.T) {
	e := newTestEngine(t, nil, []Grant{
		{Subject: "alice", ResourceType: ResourceTemplate, Namespace: "argo", Name: "build", Role: RoleViewer},
		{Subject: "alice", ResourceType: ResourceTemplate, Namespace: "argo", Name: Wildcard, Role: RoleOperator},
	})
	roles, err := e.EffectiveRoles(context.Background(), "alice", Resource{"argo", "build"})
	if err != nil {
		t.Fatalf("EffectiveRoles: %v", err)
	}
	seen := map[string]bool{}
	for _, r := range roles {
		seen[r] = true
	}
	if !seen[RoleViewer] || !seen[RoleOperator] {
		t.Errorf("expected viewer and operator on argo/build, got %v", roles)
	}
}

func TestReloadReplacesGrants(t *testing.T) {
	e := newTestEngine(t, nil, []Grant{
		{Subject: "alice", ResourceType: ResourceTemplate, Namespace: "argo", Name: Wildcard, Role: RoleViewer},
	})
	if allowed, _ := e.Allow(context.Background(), "alice", TemplateGet, Resource{"argo", "build"}); !allowed {
		t.Fatal("alice should start with access")
	}
	// Revoking is a full-table reload; the decision must flip immediately.
	if err := e.Reload(context.Background(), nil); err != nil {
		t.Fatalf("Reload: %v", err)
	}
	if allowed, _ := e.Allow(context.Background(), "alice", TemplateGet, Resource{"argo", "build"}); allowed {
		t.Error("access should be revoked after the grant table is emptied")
	}
}

// A freshly constructed engine must report that it has never loaded grants. Callers use LoadedAt to
// decide whether to read the table, and if construction looked like a successful load, every restart
// would deny all non-super-admin access until the reload interval elapsed.
func TestNewEngineIsNotMarkedLoaded(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	e, err := NewEngine(&conf.Authz{}, logger)
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}
	if !e.LoadedAt().IsZero() {
		t.Error("a new engine must have a zero LoadedAt so callers treat its empty grant table as stale")
	}
	if err := e.Reload(context.Background(), nil); err != nil {
		t.Fatalf("Reload: %v", err)
	}
	if e.LoadedAt().IsZero() {
		t.Error("Reload must record the load time")
	}
}
