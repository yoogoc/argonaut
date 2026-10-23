package argo

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func configMap(name string) *corev1.ConfigMap {
	return &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Namespace: "argo", Name: name}, Data: map[string]string{"config": "instanceID: x\n"}}
}

func TestControllerConfigMapDiscovery(t *testing.T) {
	ctx := context.Background()
	// The configured name wins when it exists.
	kube := fake.NewClientset(configMap("workflow-controller-configmap"), configMap("argo-workflows-workflow-controller-configmap"))
	if _, name, err := readControllerConfig(ctx, kube, "argo", "workflow-controller-configmap"); err != nil || name != "workflow-controller-configmap" {
		t.Fatalf("configured name: %q %v", name, err)
	}
	// A Helm-prefixed ConfigMap is found when the configured name is absent.
	kube = fake.NewClientset(configMap("argo-workflows-workflow-controller-configmap"), configMap("unrelated"))
	cfg, name, err := readControllerConfig(ctx, kube, "argo", "workflow-controller-configmap")
	if err != nil || name != "argo-workflows-workflow-controller-configmap" || cfg.InstanceID != "x" {
		t.Fatalf("discovery: %q %+v %v", name, cfg, err)
	}
	// None, or more than one, is an error that says what to set.
	if _, _, err := readControllerConfig(ctx, fake.NewClientset(), "argo", "workflow-controller-configmap"); err == nil || !strings.Contains(err.Error(), "is Argo Workflows installed") {
		t.Fatalf("none: %v", err)
	}
	kube = fake.NewClientset(configMap("a-workflow-controller-configmap"), configMap("b-workflow-controller-configmap"))
	if _, _, err := readControllerConfig(ctx, kube, "argo", "workflow-controller-configmap"); err == nil || !strings.Contains(err.Error(), "several candidates") {
		t.Fatalf("several: %v", err)
	}
}
