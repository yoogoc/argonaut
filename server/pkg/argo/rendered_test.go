package argo

import (
	"context"
	"testing"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
	wfutil "github.com/argoproj/argo-workflows/v4/workflow/util"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestEvaluateExpressions(t *testing.T) {
	vars := map[string]string{
		"workflow.parameters.r_image_map":  `{"summit":"r:4.3"}`,
		"workflow.parameters.project_code": "summit",
		"inputs.parameters.rounds":         "45",
		"tasks.my-task.outputs.result":     `{"n": 3}`,
	}
	got, err := EvaluateExpressions(context.Background(), []string{
		"sprig.fromJson(workflow.parameters.r_image_map)[workflow.parameters.project_code]",
		"asInt(inputs.parameters.rounds) * 2",
		`jsonpath(tasks['my-task'].outputs.result, '$.n')`,
		`"say \"hi\""`,
		"sprig.toJson({a: 1})",
		"inputs.parameters.missing + 1",
		"1 +",
	}, vars)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"r:4.3", "90", "3", `say "hi"`, `{"a":1}`}
	for i, w := range want {
		if got[i].Value != w || got[i].Error != "" {
			t.Errorf("expression %d: got %+v, want %q", i, got[i], w)
		}
	}
	for i := len(want); i < len(got); i++ {
		if got[i].Error == "" {
			t.Errorf("expression %d: got %+v, want an error", i, got[i])
		}
	}
}

func TestRenderedTemplateReadsThePodOrItsConfigMap(t *testing.T) {
	wf := &wfv1.Workflow{
		ObjectMeta: metav1.ObjectMeta{Name: "run", Namespace: "argo"},
		Status: wfv1.WorkflowStatus{Nodes: wfv1.Nodes{
			"run-1": {ID: "run-1", Name: "run.a", TemplateName: "tick", Type: wfv1.NodeTypePod},
			"run-2": {ID: "run-2", Name: "run.b", TemplateName: "tick", Type: wfv1.NodeTypePod},
			"run-3": {ID: "run-3", Name: "run.c", TemplateName: "tick", Type: wfv1.NodeTypePod},
			"run-4": {ID: "run-4", Name: "run.d", TemplateName: "tick", Type: wfv1.NodeTypePod},
			"run-5": {ID: "run-5", Name: "run", Type: wfv1.NodeTypeDAG},
		}},
	}
	pod := func(nodeID, nodeName, template string) *corev1.Pod {
		name := wfutil.GeneratePodName("run", nodeName, "tick", nodeID, wfutil.GetWorkflowPodNameVersion(wf))
		return &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "argo", Labels: map[string]string{common.LabelKeyWorkflow: "run"}, Annotations: map[string]string{common.AnnotationKeyNodeID: nodeID}},
			Spec: corev1.PodSpec{
				InitContainers: []corev1.Container{{Name: "init", Env: []corev1.EnvVar{{Name: common.EnvVarTemplate, Value: template}}}},
				Containers:     []corev1.Container{{Name: "main"}},
			},
		}
	}
	direct := pod("run-1", "run.a", `{"name":"tick","container":{"args":["45"]}}`)
	offloaded := pod("run-2", "run.b", common.EnvVarTemplateOffloaded)
	foreign := pod("run-3", "run.c", `{"name":"other"}`)
	foreign.Annotations[common.AnnotationKeyNodeID] = "someone-else"
	cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: offloaded.Name, Namespace: "argo"}, Data: map[string]string{common.EnvVarTemplate: `{"name":"big"}`}}
	s := &Servers{Clients: &Clients{Kubernetes: fake.NewClientset(direct, offloaded, foreign, cm)}}

	for _, tc := range []struct{ node, want string }{
		{"run-1", `{"name":"tick","container":{"args":["45"]}}`},
		{"run-2", `{"name":"big"}`},
		{"run-3", ""}, // the pod at that name belongs to another node
		{"run-4", ""}, // garbage collected
		{"run-5", ""}, // not a pod node
	} {
		got, err := s.RenderedTemplate(context.Background(), wf, tc.node)
		if err != nil {
			t.Fatalf("%s: %v", tc.node, err)
		}
		if got.JSON != tc.want {
			t.Errorf("%s: got %q, want %q", tc.node, got.JSON, tc.want)
		}
	}
	if _, err := s.RenderedTemplate(context.Background(), wf, "missing"); err == nil {
		t.Error("unknown node: want an error")
	}
}
