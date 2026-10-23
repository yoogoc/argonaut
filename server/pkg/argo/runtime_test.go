package argo

import (
	"context"
	"errors"
	"testing"

	"argonaut/internal/conf"
)

func TestChoicesMergeOverTopLevel(t *testing.T) {
	top := &conf.Kube{Context: "default", Namespaces: []string{"argo", "team"}, Qps: 50, ExecEnv: map[string]string{"A": "1"}}
	argo := &conf.Argo{ControllerNamespace: "argo", ControllerConfigmap: "workflow-controller-configmap"}
	choices, _, err := Choices(top, argo, &conf.ClusterSwitch{Enabled: true, Clusters: []*conf.ClusterSwitch_Cluster{
		{Id: "local"},
		{Id: "eks", Name: "EKS", Env: "prod",
			Kube: &conf.Kube{Context: "eks-ctx", Namespaces: []string{"argo"}, ExecEnv: map[string]string{"AWS_PROFILE": "dev"}},
			Argo: &conf.Argo{ControllerConfigmap: "argo-workflows-workflow-controller-configmap"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	local, eks := choices[0], choices[1]
	if local.Name != "local" || local.Kube.GetContext() != "default" || len(local.Kube.GetNamespaces()) != 2 {
		t.Fatalf("a cluster without overrides should inherit everything: %+v", local)
	}
	if eks.Kube.GetContext() != "eks-ctx" || eks.Kube.GetQps() != 50 {
		t.Fatalf("overrides replace set fields and keep the rest: %+v", eks.Kube)
	}
	if ns := eks.Kube.GetNamespaces(); len(ns) != 1 || ns[0] != "argo" {
		t.Fatalf("a cluster's namespaces replace the top-level list, got %v", ns)
	}
	if eks.Kube.GetExecEnv()["AWS_PROFILE"] != "dev" || eks.Kube.GetExecEnv()["A"] != "1" {
		t.Fatalf("exec env is merged: %v", eks.Kube.GetExecEnv())
	}
	if eks.Argo.GetControllerNamespace() != "argo" || eks.Argo.GetControllerConfigmap() != "argo-workflows-workflow-controller-configmap" {
		t.Fatalf("argo settings merge field by field: %+v", eks.Argo)
	}
	if top.GetContext() != "default" || len(top.GetNamespaces()) != 2 {
		t.Fatalf("merging must not modify the top-level config: %+v", top)
	}
}

func TestChoicesRejectBadConfig(t *testing.T) {
	cases := map[string]*conf.ClusterSwitch{
		"no clusters":     {Enabled: true},
		"missing id":      {Enabled: true, Clusters: []*conf.ClusterSwitch_Cluster{{Name: "x"}}},
		"duplicate id":    {Enabled: true, Clusters: []*conf.ClusterSwitch_Cluster{{Id: "a"}, {Id: "a"}}},
		"unknown default": {Enabled: true, Default: "b", Clusters: []*conf.ClusterSwitch_Cluster{{Id: "a"}}},
	}
	for name, sw := range cases {
		if _, _, err := Choices(&conf.Kube{}, &conf.Argo{}, sw); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestPinKeepsARequestOnItsCluster(t *testing.T) {
	sw := FixedSwitch(nil, nil, nil)
	first := sw.Current()
	ctx := sw.Pin(context.Background())
	// Simulate a switch landing while the request runs.
	second := &Runtime{ID: "other", done: make(chan struct{}), stop: func() {}}
	sw.current.Store(second)
	if sw.For(ctx) != first {
		t.Fatal("a pinned request moved to the new cluster mid-flight")
	}
	if sw.For(context.Background()) != second {
		t.Fatal("unpinned work should use the current cluster")
	}
	if sw.For(sw.Pin(ctx)) != first {
		t.Fatal("pinning twice must keep the first pin")
	}
}

func TestSubscribeSeesCurrentRuntime(t *testing.T) {
	sw := FixedSwitch(nil, nil, nil)
	var seen []*Runtime
	sw.Subscribe(func(rt *Runtime) { seen = append(seen, rt) })
	if len(seen) != 1 || seen[0] != sw.Current() {
		t.Fatalf("subscribe should deliver the current runtime immediately, got %v", seen)
	}
}

func TestSwitchRefusedWhenDisabledOrUnknown(t *testing.T) {
	sw := FixedSwitch(nil, nil, nil)
	if _, err := sw.Switch(context.Background(), "x"); !errors.Is(err, ErrSwitchDisabled) {
		t.Fatalf("disabled switch: got %v", err)
	}
	sw.enabled = true
	sw.choices = []ClusterChoice{{ID: "a"}}
	if _, err := sw.Switch(context.Background(), "nope"); err == nil {
		t.Fatal("switching to an unknown cluster was accepted")
	}
}

func TestBindEndsWithTheRuntime(t *testing.T) {
	rt := &Runtime{done: make(chan struct{})}
	ctx, cancel := rt.Bind(context.Background())
	defer cancel()
	close(rt.done)
	<-ctx.Done()
}

func TestChoicesFromKubeconfig(t *testing.T) {
	saved := loadKubeconfig
	defer func() { loadKubeconfig = saved }()
	loadKubeconfig = func(*conf.Kube) ([]string, string, error) {
		return []string{"aliyun-prod", "arn:aws:eks:us-east-1:123456789012:cluster/web-dev-cluster", "default", "xy-uat"}, "default", nil
	}
	top := &conf.Kube{Context: "pinned-elsewhere", Namespaces: []string{"argo"}}
	argo := &conf.Argo{ControllerNamespace: "argo"}
	sw := &conf.ClusterSwitch{Enabled: true, FromKubeconfig: true, Clusters: []*conf.ClusterSwitch_Cluster{
		{Id: "default", Name: "本地 k3s", Argo: &conf.Argo{ControllerConfigmap: "workflow-controller-configmap"}},
		{Id: "extra", Name: "Extra", Kube: &conf.Kube{Context: "extra-ctx"}},
	}}
	choices, current, err := Choices(top, argo, sw)
	if err != nil {
		t.Fatal(err)
	}
	if current != "default" {
		t.Fatalf("current-context = %q", current)
	}
	byID := map[string]ClusterChoice{}
	for _, c := range choices {
		byID[c.ID] = c
	}
	if len(choices) != 5 {
		t.Fatalf("want 4 contexts plus the extra entry, got %d", len(choices))
	}
	eks := byID["arn:aws:eks:us-east-1:123456789012:cluster/web-dev-cluster"]
	if eks.Name != "web-dev-cluster" || eks.Kube.GetContext() != eks.ID || eks.Kube.GetNamespaces()[0] != "argo" {
		t.Fatalf("a context becomes a choice connecting to itself, inheriting the rest: %+v %+v", eks, eks.Kube)
	}
	if byID["aliyun-prod"].Env != "prod" || byID["xy-uat"].Env != "uat" || byID["default"].Env != "" {
		t.Fatalf("env guesses: prod=%q uat=%q default=%q", byID["aliyun-prod"].Env, byID["xy-uat"].Env, byID["default"].Env)
	}
	local := byID["default"]
	if local.Name != "本地 k3s" || local.Argo.GetControllerConfigmap() != "workflow-controller-configmap" || local.Argo.GetControllerNamespace() != "argo" {
		t.Fatalf("an entry with a context's id overrides it: %+v %+v", local, local.Argo)
	}
	if byID["extra"].Kube.GetContext() != "extra-ctx" {
		t.Fatalf("entries matching no context are still offered: %+v", byID["extra"])
	}
	// No default and a pinned context that is not in the kubeconfig: the current-context wins.
	if got := pickInitial(choices, sw.GetDefault(), top.GetContext(), current); got.ID != "default" {
		t.Fatalf("initial cluster = %q", got.ID)
	}
}

func TestContextEnv(t *testing.T) {
	cases := map[string]string{
		"aliyun-prod": "prod", "web-prod-cluster": "prod", "arn:aws:eks:us-east-1:1:cluster/web-prod-cluster": "prod", "prd-east": "prod",
		"xy-aliyun-dev": "", "product-team": "", "uat-1": "uat", "staging": "uat", "default": "",
	}
	for name, want := range cases {
		if got := contextEnv(name); got != want {
			t.Errorf("contextEnv(%q) = %q, want %q", name, got, want)
		}
	}
}
