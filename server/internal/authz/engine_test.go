package authz

import (
	"io"
	"log/slog"
	"testing"

	"argonaut/internal/conf"
)

func newTestEngine(t *testing.T, readable *bool) *Engine {
	t.Helper()
	e, err := NewEngine(&conf.Authz{SuperAdmins: []string{"user:root"}, ClusterTemplatesReadable: readable}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestNothingLoadedDeniesEveryoneButSuperAdmins(t *testing.T) {
	e := newTestEngine(t, nil)
	if e.Allow("alice", WorkflowGet, Resource{Namespace: "argo"}) {
		t.Fatal("unloaded engine allowed a regular user")
	}
	if !e.Allow("root", AuthzGrant, Global()) {
		t.Fatal("super admin denied")
	}
}

func TestScopesAndRoleNesting(t *testing.T) {
	e := newTestEngine(t, nil)
	e.Load(Snapshot{Revision: 7, Grants: []Grant{
		{Subject: "alice", ResourceType: ResourceTemplate, Namespace: "argo", Name: "etl", Role: RoleOperator},
		{Subject: "bob", ResourceType: ResourceNamespace, Namespace: "argo", Role: RoleEditor},
		{Subject: "carol", ResourceType: ResourceGlobal, Role: RoleViewer},
		{Subject: "dave", ResourceType: ResourceClusterTemplate, Name: "spark", Role: RoleEditor},
	}})

	cases := []struct {
		subject string
		action  Action
		res     Resource
		want    bool
	}{
		// A template grant covers that template and nothing else.
		{"alice", WorkflowRetry, Resource{Namespace: "argo", Template: "etl"}, true},
		{"alice", WorkflowGet, Resource{Namespace: "argo", Template: "etl"}, true}, // operator includes viewer
		{"alice", TemplateUpdate, Resource{Namespace: "argo", Template: "etl"}, false},
		{"alice", WorkflowRetry, Resource{Namespace: "argo", Template: "other"}, false},
		{"alice", WorkflowRetry, Resource{Namespace: "argo"}, false}, // runs without a template
		// A namespace grant covers every template in it and template-less runs.
		{"bob", TemplateUpdate, Resource{Namespace: "argo", Template: "anything"}, true},
		{"bob", WorkflowSubmit, Resource{Namespace: "argo"}, true},
		{"bob", AuthzGrant, Resource{Namespace: "argo"}, false},
		{"bob", WorkflowGet, Resource{Namespace: "other"}, false},
		{"bob", TemplateGet, Resource{ClusterTemplate: "spark"}, true}, // readable by default
		{"bob", TemplateUpdate, Resource{ClusterTemplate: "spark"}, false},
		// A global grant covers everything, cluster templates included.
		{"carol", WorkflowGet, Resource{Namespace: "x", Template: "y"}, true},
		{"carol", WorkflowDelete, Resource{Namespace: "x"}, false},
		// A cluster template grant covers only the definition.
		{"dave", TemplateUpdate, Resource{ClusterTemplate: "spark"}, true},
		{"dave", WorkflowSubmit, Resource{Namespace: "argo"}, false},
	}
	for _, c := range cases {
		if got := e.Allow(c.subject, c.action, c.res); got != c.want {
			t.Errorf("%s %s %+v = %v, want %v", c.subject, c.action, c.res, got, c.want)
		}
	}
	if d := e.Decide("alice", WorkflowRetry, Resource{Namespace: "argo", Template: "etl"}); d.Revision != 7 || len(d.Policies) == 0 || d.Policies[0] != "role-operator" {
		t.Errorf("decision = %+v", d)
	}
}

func TestClusterTemplatesReadableCanBeDisabled(t *testing.T) {
	off := false
	e := newTestEngine(t, &off)
	e.Load(Snapshot{Revision: 1})
	if e.Allow("bob", TemplateGet, Resource{ClusterTemplate: "spark"}) {
		t.Fatal("cluster template readable although disabled")
	}
}

func TestCustomForbidPolicy(t *testing.T) {
	e := newTestEngine(t, nil)
	e.Load(Snapshot{Revision: 2,
		Grants: []Grant{{Subject: "alice", ResourceType: ResourceNamespace, Namespace: "argo", Role: RoleOperator}},
		Policies: []CustomPolicy{{Name: "prod-no-terminate", Enabled: true, Body: `
forbid (principal, action == Action::"workflow:terminate", resource)
when { resource.labels has env && resource.labels.env == "prod" };`}},
	})
	prod := Resource{Namespace: "argo", Labels: map[string]string{"env": "prod"}}
	if e.Allow("alice", WorkflowTerminate, prod) {
		t.Fatal("forbid policy ignored")
	}
	d := e.Decide("alice", WorkflowTerminate, prod)
	if len(d.Policies) != 1 || d.Policies[0] != "custom:prod-no-terminate" {
		t.Errorf("reasons = %v", d.Policies)
	}
	if !e.Allow("alice", WorkflowTerminate, Resource{Namespace: "argo", Labels: map[string]string{"env": "dev"}}) {
		t.Fatal("forbid policy over-applied")
	}
	if !e.Allow("alice", WorkflowStop, prod) {
		t.Fatal("forbid policy matched another action")
	}
}

func TestBrokenCustomPolicyIsSkipped(t *testing.T) {
	e := newTestEngine(t, nil)
	e.Load(Snapshot{Revision: 3,
		Grants:   []Grant{{Subject: "alice", ResourceType: ResourceNamespace, Namespace: "argo", Role: RoleViewer}},
		Policies: []CustomPolicy{{Name: "broken", Enabled: true, Body: "forbid ("}},
	})
	if !e.Allow("alice", WorkflowGet, Resource{Namespace: "argo"}) {
		t.Fatal("a broken custom policy took down the built-in ones")
	}
	if _, ok := e.BrokenPolicies()["broken"]; !ok {
		t.Fatal("broken policy not reported")
	}
}

func TestActions(t *testing.T) {
	e := newTestEngine(t, nil)
	e.Load(Snapshot{Revision: 1, Grants: []Grant{{Subject: "v", ResourceType: ResourceNamespace, Namespace: "argo", Role: RoleViewer}}})
	if got := len(e.Actions("v", Resource{Namespace: "argo"})); got != len(viewerActions) {
		t.Fatalf("viewer actions = %d, want %d", got, len(viewerActions))
	}
}
