package argo

import (
	"context"
	"fmt"
	"io"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/workflow/artifactrepositories"
	artifact "github.com/argoproj/argo-workflows/v4/workflow/artifacts"
	wfutil "github.com/argoproj/argo-workflows/v4/workflow/util"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// This is a port of argo-server's ArtifactServer.getArtifactAndDriver. We can't call that method
// (it is unexported, and its HTTP entrypoints hard-code path segment offsets), but we reuse the
// pieces that matter: Argo's repository resolution and its driver factory, which covers
// s3/gcs/oss/azure/hdfs/http. Repository credentials come from the cluster at runtime — the
// workflow's own ArtifactRepositoryRef, the namespace default, or the controller ConfigMap — so
// argonaut never duplicates artifact storage configuration.

// resources implements the resource interface Argo's drivers use to read credentials.
type resources struct {
	kubeClient kubernetes.Interface
	namespace  string
}

func (r resources) GetSecret(ctx context.Context, name, key string) (string, error) {
	secret, err := r.kubeClient.CoreV1().Secrets(r.namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	return string(secret.Data[key]), nil
}

func (r resources) GetConfigMapKey(ctx context.Context, name, key string) (string, error) {
	configMap, err := r.kubeClient.CoreV1().ConfigMaps(r.namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	return configMap.Data[key], nil
}

// ArtifactReader opens workflow artifacts straight from the object store.
type ArtifactReader struct {
	kubeClient kubernetes.Interface
	repos      artifactrepositories.Interface
}

// NewArtifactReader builds a reader over the artifact repositories resolved from the cluster.
func NewArtifactReader(clients *Clients, repos artifactrepositories.Interface) *ArtifactReader {
	return &ArtifactReader{kubeClient: clients.Kubernetes, repos: repos}
}

// Open locates a node's named artifact and opens it for streaming. The caller closes the reader.
func (r *ArtifactReader) Open(ctx context.Context, wf *wfv1.Workflow, nodeID, artifactName string, isInput bool) (*wfv1.Artifact, io.ReadCloser, error) {
	art, err := r.locate(wf, nodeID, artifactName, isInput)
	if err != nil {
		return nil, nil, err
	}

	location, err := r.resolveLocation(ctx, wf, nodeID)
	if err != nil {
		return nil, nil, err
	}
	// Relocate fills in the repository-specific location (bucket, key prefix) that the workflow
	// status only records by reference.
	if err := art.Relocate(location); err != nil {
		return nil, nil, err
	}

	driver, err := artifact.NewDriver(ctx, art, resources{r.kubeClient, wf.Namespace})
	if err != nil {
		return nil, nil, err
	}
	reader, err := driver.OpenStream(ctx, art)
	if err != nil {
		return nil, nil, err
	}
	return art, reader, nil
}

func (r *ArtifactReader) locate(wf *wfv1.Workflow, nodeID, artifactName string, isInput bool) (*wfv1.Artifact, error) {
	nodeStatus, err := wf.Status.Nodes.Get(nodeID)
	if err != nil {
		return nil, fmt.Errorf("node %q not found in workflow %s/%s", nodeID, wf.Namespace, wf.Name)
	}
	var art *wfv1.Artifact
	if isInput {
		if nodeStatus.Inputs == nil {
			return nil, fmt.Errorf("node %q has no inputs", nodeID)
		}
		art = nodeStatus.Inputs.GetArtifactByName(artifactName)
	} else {
		if nodeStatus.Outputs == nil {
			return nil, fmt.Errorf("node %q has no outputs", nodeID)
		}
		art = nodeStatus.Outputs.GetArtifactByName(artifactName)
	}
	if art == nil {
		return nil, fmt.Errorf("artifact %q not found on node %q (isInput=%t)", artifactName, nodeID, isInput)
	}
	return art, nil
}

// resolveLocation prefers the template's own ArchiveLocation and otherwise falls back to the
// repository the workflow was run against.
func (r *ArtifactReader) resolveLocation(ctx context.Context, wf *wfv1.Workflow, nodeID string) (*wfv1.ArtifactLocation, error) {
	nodeStatus, err := wf.Status.Nodes.Get(nodeID)
	if err != nil {
		return nil, fmt.Errorf("node %q not found", nodeID)
	}
	if templateName := wfutil.GetTemplateFromNode(*nodeStatus); templateName != "" {
		if tmpl := wf.GetTemplateByName(templateName); tmpl != nil && tmpl.ArchiveLocation.HasLocation() {
			return tmpl.ArchiveLocation, nil
		}
	}
	repo, err := r.repos.Get(ctx, wf.Status.ArtifactRepositoryRef)
	if err != nil {
		return nil, fmt.Errorf("resolving artifact repository: %w", err)
	}
	if repo == nil {
		return nil, fmt.Errorf("no artifact repository configured for workflow %s/%s", wf.Namespace, wf.Name)
	}
	return repo.ToArtifactLocation(), nil
}

// LogArtifactNames are the artifact names Argo writes container logs to. Reading them is how a
// finished workflow still shows logs after its pods have been garbage collected.
var LogArtifactNames = []string{"main-logs", "main.log"}

// OpenLogs opens a node's archived container log, used as the fallback when the pod is gone.
func (r *ArtifactReader) OpenLogs(ctx context.Context, wf *wfv1.Workflow, nodeID string) (io.ReadCloser, error) {
	var lastErr error
	for _, name := range LogArtifactNames {
		_, reader, err := r.Open(ctx, wf, nodeID, name, false)
		if err == nil {
			return reader, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("no archived logs for node %q: %w", nodeID, lastErr)
}
