package biz

import (
	"context"
	"encoding/json"
	"time"
)

// Template scopes in the revision table.
const (
	ScopeNamespace = "namespace"
	ScopeCluster   = "cluster"
)

// TemplateRevision is one recorded version of a WorkflowTemplate or ClusterWorkflowTemplate
// (DESIGN §3.6). Kubernetes keeps no history and sees every write as the platform ServiceAccount, so
// this table is the only record of who changed a template and what it looked like before.
type TemplateRevision struct {
	ID string
	// Cluster is the switchable cluster the template lives in; empty for the single configured one.
	Cluster         string
	Scope           string
	Namespace       string
	Name            string
	Seq             int
	UID             string
	ResourceVersion string
	Manifest        json.RawMessage
	Author          string
	// External marks a change observed on the cluster that did not come through argonaut (kubectl,
	// GitOps); its author is unknown.
	External  bool
	Message   string
	CreatedAt time.Time
}

// RevisionRepo persists template history.
type RevisionRepo interface {
	// Record appends a revision unless the latest one already has the same resourceVersion.
	Record(ctx context.Context, rev TemplateRevision) (TemplateRevision, bool, error)
	List(ctx context.Context, cluster, scope, namespace, name string) ([]TemplateRevision, error)
	Get(ctx context.Context, id string) (TemplateRevision, error)
	HasResourceVersion(ctx context.Context, cluster, scope, namespace, name, resourceVersion string) (bool, error)
}

func mustJSON(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return raw
}
