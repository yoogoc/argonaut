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
func readControllerConfig(ctx context.Context, kube kubernetes.Interface, namespace, name string) (*config.Config, error) {
	cm, err := kube.CoreV1().ConfigMaps(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsUnauthorized(err) {
			// A 401 is authentication, not permission: the credentials were rejected outright. With an
			// exec-based kubeconfig (EKS, GKE) this usually means the credential plugin could not run
			// or produced an expired token, which is invisible unless it is called out.
			return nil, fmt.Errorf(
				"kubernetes rejected our credentials while reading %s/%s: %w"+
					" (if this kubeconfig context uses a credential plugin, check that the plugin is on"+
					" PATH and that its credentials, such as AWS_PROFILE, are set for this process)",
				namespace, name, err)
		}
		if apierrors.IsForbidden(err) {
			return nil, fmt.Errorf(
				"not allowed to read %s/%s: %w (the ServiceAccount needs get on configmaps in that namespace)",
				namespace, name, err)
		}
		return nil, fmt.Errorf("reading argo controller configmap %s/%s: %w", namespace, name, err)
	}

	cfg := &config.Config{}
	if err := yaml.Unmarshal([]byte(rawControllerConfig(cm.Data)), cfg); err != nil {
		return nil, fmt.Errorf("parsing argo controller configmap %s/%s: %w", namespace, name, err)
	}
	return cfg, nil
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
