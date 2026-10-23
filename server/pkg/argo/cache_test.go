package argo

import (
	"testing"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestRunParametersMergesTemplateDefaultsUnderSubmittedValues(t *testing.T) {
	desc := wfv1.AnyString("long description")
	wf := &wfv1.Workflow{
		Spec: wfv1.WorkflowSpec{Arguments: wfv1.Arguments{Parameters: []wfv1.Parameter{
			{Name: "env", Value: wfv1.AnyStringPtr("uat")},
			{Name: "extra", Value: wfv1.AnyStringPtr("x")},
		}}},
		Status: wfv1.WorkflowStatus{StoredWorkflowSpec: &wfv1.WorkflowSpec{Arguments: wfv1.Arguments{Parameters: []wfv1.Parameter{
			{Name: "project_id", Value: wfv1.AnyStringPtr("16")},
			{Name: "env", Value: wfv1.AnyStringPtr("dev"), Description: &desc},
			{Name: "ds_str", Value: wfv1.AnyStringPtr("")},
		}}}},
	}
	got := runParameters(wf)
	want := [][2]string{{"project_id", "16"}, {"env", "uat"}, {"ds_str", ""}, {"extra", "x"}}
	if len(got) != len(want) {
		t.Fatalf("got %d parameters, want %d: %+v", len(got), len(want), got)
	}
	for i, w := range want {
		if got[i].Name != w[0] || got[i].Value.String() != w[1] {
			t.Errorf("parameter %d = %s=%s, want %s=%s", i, got[i].Name, got[i].Value.String(), w[0], w[1])
		}
		if got[i].Description != nil {
			t.Errorf("parameter %s kept its description", got[i].Name)
		}
	}
}

func TestParamFilters(t *testing.T) {
	wf := &wfv1.Workflow{Spec: wfv1.WorkflowSpec{Arguments: wfv1.Arguments{Parameters: []wfv1.Parameter{
		{Name: "env", Value: wfv1.AnyStringPtr("uat")},
		{Name: "projects", Value: wfv1.AnyStringPtr("3,5,13")},
		{Name: "url", Value: wfv1.AnyStringPtr("https://x.io/a=b")},
		{Name: "ds_str", Value: wfv1.AnyStringPtr("")},
	}}}}
	cases := []struct {
		terms []string
		want  bool
	}{
		{nil, true},
		{[]string{"env=uat"}, true},
		{[]string{"env=UAT"}, false},
		{[]string{"env~UA"}, true},
		{[]string{"projects=3,5,13"}, true},
		{[]string{"url=https://x.io/a=b"}, true},
		{[]string{"ds_str"}, true},
		{[]string{"ds_str="}, true},
		{[]string{"missing"}, false},
		{[]string{"env=uat", "projects~13"}, true},
		{[]string{"env=uat", "projects~99"}, false},
	}
	for _, c := range cases {
		filters, err := ParseParamFilters(c.terms)
		if err != nil {
			t.Fatalf("%v: %v", c.terms, err)
		}
		if got := matchParams(wf, filters); got != c.want {
			t.Errorf("%v: got %v, want %v", c.terms, got, c.want)
		}
	}
	if _, err := ParseParamFilters([]string{"=uat"}); err == nil {
		t.Error("a term without a name was accepted")
	}
}

func TestWorkflowSource(t *testing.T) {
	cases := []struct {
		wf   wfv1.Workflow
		want string
	}{
		{wfv1.Workflow{Spec: wfv1.WorkflowSpec{WorkflowTemplateRef: &wfv1.WorkflowTemplateRef{Name: "etl"}}}, "etl"},
		{wfv1.Workflow{Spec: wfv1.WorkflowSpec{WorkflowTemplateRef: &wfv1.WorkflowTemplateRef{Name: "spark", ClusterScope: true}}}, "cluster/spark"},
		{wfv1.Workflow{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{common.LabelKeyWorkflowTemplate: "etl"}}}, "etl"},
		{wfv1.Workflow{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{common.LabelKeyClusterWorkflowTemplate: "spark"}}}, "cluster/spark"},
		{wfv1.Workflow{}, ""},
	}
	for i, c := range cases {
		if got := WorkflowSource(&c.wf); got != c.want {
			t.Errorf("case %d: got %q, want %q", i, got, c.want)
		}
	}
}
