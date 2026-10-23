package argo

import (
	"context"
	"fmt"
	"strings"

	"github.com/argoproj/argo-workflows/v4/config"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/yaml"
)

// readControllerConfig loads the Argo controller's ConfigMap.
//
// Argo's own config.Controller.Get is not used because it parses strictly: a single field the pinned
// client library does not know about — and the controller in a cluster is frequently newer than the
// library — aborts startup. Since this server only needs the artifact repository, the persistence
// settings, the links and the instance ID, parsing tolerantly keeps it compatible with newer Argo
// installations instead of pinning the whole platform to one controller version.
//
// If the named ConfigMap does not exist, the one ConfigMap in the namespace whose name ends in
// "workflow-controller-configmap" is used instead and its name returned: a plain install names it
// exactly that and a Helm install prefixes the release name, and a cluster picked from the kubeconfig
// (cluster_switch.from_kubeconfig) comes with no setting saying which.
func readControllerConfig(ctx context.Context, kube kubernetes.Interface, namespace, name string) (*config.Config, string, error) {
	cm, err := kube.CoreV1().ConfigMaps(namespace).Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		found, findErr := findControllerConfigMap(ctx, kube, namespace, name)
		if findErr != nil {
			return nil, "", findErr
		}
		name = found
		cm, err = kube.CoreV1().ConfigMaps(namespace).Get(ctx, name, metav1.GetOptions{})
	}
	if err != nil {
		if apierrors.IsUnauthorized(err) {
			// A 401 is authentication, not permission: the credentials were rejected outright. With an
			// exec-based kubeconfig (EKS, GKE) this usually means the credential plugin could not run
			// or produced an expired token, which is invisible unless it is called out.
			return nil, "", fmt.Errorf(
				"kubernetes rejected our credentials while reading %s/%s: %w"+
					" (if this kubeconfig context uses a credential plugin, check that the plugin is on"+
					" PATH and that its credentials, such as AWS_PROFILE, are set for this process)",
				namespace, name, err)
		}
		if apierrors.IsForbidden(err) {
			return nil, "", fmt.Errorf(
				"not allowed to read %s/%s: %w (the ServiceAccount needs get on configmaps in that namespace)",
				namespace, name, err)
		}
		if strings.Contains(err.Error(), "getting credentials: exec") {
			// The kubeconfig's credential plugin itself failed (aws eks get-token exiting 255, say);
			// its stderr is not part of the error, so point at the usual cause.
			return nil, "", fmt.Errorf("the kubeconfig credential plugin failed while reading %s/%s: %w"+
				" (run the plugin by hand to see why; for EKS check that the AWS profile it uses exists and is"+
				" logged in, and set AWS_PROFILE for this cluster with kube.exec_env)", namespace, name, err)
		}
		return nil, "", fmt.Errorf("reading argo controller configmap %s/%s: %w", namespace, name, err)
	}

	cfg := &config.Config{}
	if err := yaml.Unmarshal([]byte(rawControllerConfig(cm.Data)), cfg); err != nil {
		return nil, "", fmt.Errorf("parsing argo controller configmap %s/%s: %w", namespace, name, err)
	}
	return cfg, name, nil
}

const controllerConfigMapSuffix = "workflow-controller-configmap"

// findControllerConfigMap looks for the controller's ConfigMap when the configured name is absent.
func findControllerConfigMap(ctx context.Context, kube kubernetes.Interface, namespace, configured string) (string, error) {
	list, err := kube.CoreV1().ConfigMaps(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return "", fmt.Errorf("argo controller configmap %s/%s not found, and listing configmaps to find it failed: %w", namespace, configured, err)
	}
	var candidates []string
	for _, cm := range list.Items {
		if strings.HasSuffix(cm.Name, controllerConfigMapSuffix) {
			candidates = append(candidates, cm.Name)
		}
	}
	switch len(candidates) {
	case 1:
		return candidates[0], nil
	case 0:
		return "", fmt.Errorf("no argo controller configmap in namespace %q (looked for %q, then any *%s): is Argo Workflows installed there? Set argo.controller_namespace for this cluster",
			namespace, configured, controllerConfigMapSuffix)
	default:
		return "", fmt.Errorf("argo controller configmap %s/%s not found, and namespace %q has several candidates %v: set argo.controller_configmap for this cluster",
			namespace, configured, namespace, candidates)
	}
}

// rawControllerConfig assembles the YAML document from the ConfigMap, mirroring how Argo's controller
// reads it: either a single "config" key holding the whole document, or one key per top-level setting.
func rawControllerConfig(data map[string]string) string {
	if raw, ok := data["config"]; ok {
		return raw
	}

	var builder strings.Builder
	for name, value := range data {
		if strings.Contains(value, "\n") {
			// A multi-line value is a nested block, so it has to be re-indented under its key.
			builder.WriteString(name + ":\n  " +
				strings.Join(strings.Split(strings.Trim(value, "\n"), "\n"), "\n  ") + "\n")
			continue
		}
		builder.WriteString(name + ": " + value + "\n")
	}
	return builder.String()
}
