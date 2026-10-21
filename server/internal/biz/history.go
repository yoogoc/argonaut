package biz

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	pkgargo "argonaut/pkg/argo"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Annotations argonaut writes on templates it saves.
const (
	AnnotationLastModifiedBy = "argonaut.io/last-modified-by"
	AnnotationLayout         = "argonaut.io/layout"
	LabelComponent           = "argonaut.io/component"
)

// externalSettle is how long a change seen by the informer waits before being judged external. A save
// through argonaut records its revision right after the API call returns, and the informer can deliver
// the same change first; waiting lets that record land so our own saves are not misread as kubectl.
const externalSettle = 3 * time.Second

// TemplateHistory records template revisions (DESIGN §3.6): every save through argonaut with its
// author, and every change observed on the cluster that did not come through argonaut.
type TemplateHistory struct {
	log   *slog.Logger
	repo  RevisionRepo
	audit *Auditor
}

func NewTemplateHistory(repo RevisionRepo, cache *pkgargo.Cache, auditor *Auditor, logger *slog.Logger) *TemplateHistory {
	h := &TemplateHistory{log: logger.With("module", "biz/history"), repo: repo, audit: auditor}
	cache.OnTemplateChange(h.observe)
	return h
}

// snapshotManifest keeps what defines a template, without server-managed noise.
func snapshotManifest(kind string, meta metav1.ObjectMeta, spec wfv1.WorkflowSpec) json.RawMessage {
	annotations := map[string]string{}
	for k, v := range meta.Annotations {
		if k == "kubectl.kubernetes.io/last-applied-configuration" {
			continue
		}
		annotations[k] = v
	}
	m := map[string]any{
		"apiVersion": "argoproj.io/v1alpha1",
		"kind":       kind,
		"metadata": map[string]any{
			"name":        meta.Name,
			"namespace":   meta.Namespace,
			"labels":      meta.Labels,
			"annotations": annotations,
		},
		"spec": spec,
	}
	if meta.Namespace == "" {
		delete(m["metadata"].(map[string]any), "namespace")
	}
	return mustJSON(m)
}

// RecordTemplate records a save made through argonaut.
func (h *TemplateHistory) RecordTemplate(ctx context.Context, t *wfv1.WorkflowTemplate, author, message string) {
	h.record(ctx, TemplateRevision{
		Scope: ScopeNamespace, Namespace: t.Namespace, Name: t.Name, UID: string(t.UID), ResourceVersion: t.ResourceVersion,
		Manifest: snapshotManifest("WorkflowTemplate", t.ObjectMeta, t.Spec), Author: author, Message: message,
	})
}

// RecordClusterTemplate records a cluster template save made through argonaut.
func (h *TemplateHistory) RecordClusterTemplate(ctx context.Context, t *wfv1.ClusterWorkflowTemplate, author, message string) {
	h.record(ctx, TemplateRevision{
		Scope: ScopeCluster, Name: t.Name, UID: string(t.UID), ResourceVersion: t.ResourceVersion,
		Manifest: snapshotManifest("ClusterWorkflowTemplate", t.ObjectMeta, t.Spec), Author: author, Message: message,
	})
}

func (h *TemplateHistory) record(ctx context.Context, rev TemplateRevision) {
	if _, _, err := h.repo.Record(context.WithoutCancel(ctx), rev); err != nil {
		h.log.Error("recording template revision failed", "err", err, "name", rev.Name)
	}
}

// observe handles informer events. The first sight of a template becomes its baseline revision; a
// later change no revision accounts for is recorded as an external edit.
func (h *TemplateHistory) observe(change pkgargo.TemplateChange) {
	if change.Deleted {
		return
	}
	var rev TemplateRevision
	switch {
	case change.Template != nil:
		t := change.Template
		rev = TemplateRevision{Scope: ScopeNamespace, Namespace: t.Namespace, Name: t.Name, UID: string(t.UID), ResourceVersion: t.ResourceVersion,
			Manifest: snapshotManifest("WorkflowTemplate", t.ObjectMeta, t.Spec)}
	case change.ClusterTemplate != nil:
		t := change.ClusterTemplate
		rev = TemplateRevision{Scope: ScopeCluster, Name: t.Name, UID: string(t.UID), ResourceVersion: t.ResourceVersion,
			Manifest: snapshotManifest("ClusterWorkflowTemplate", t.ObjectMeta, t.Spec)}
	default:
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if !change.Initial {
			time.Sleep(externalSettle)
		}
		known, err := h.repo.HasResourceVersion(ctx, rev.Scope, rev.Namespace, rev.Name, rev.ResourceVersion)
		if err != nil || known {
			return
		}
		existing, err := h.repo.List(ctx, rev.Scope, rev.Namespace, rev.Name)
		if err != nil {
			return
		}
		rev.External = true
		if len(existing) == 0 {
			rev.Message = "first seen by argonaut"
		} else {
			rev.Message = "changed outside argonaut"
		}
		recorded, ok, err := h.repo.Record(ctx, rev)
		if err != nil {
			h.log.Error("recording external template change failed", "err", err, "name", rev.Name)
			return
		}
		if ok && len(existing) > 0 {
			h.audit.RecordEvent(ctx, AuditEvent{
				Actor: "", Action: "template:external", ResourceType: map[string]string{ScopeNamespace: "template", ScopeCluster: "cluster_template"}[rev.Scope],
				Namespace: rev.Namespace, Name: rev.Name, Result: AuditRecorded,
				Reason: "changed outside argonaut", Detail: mustJSON(map[string]any{"revision": recorded.Seq, "resourceVersion": rev.ResourceVersion}),
			})
		}
	}()
}

func (h *TemplateHistory) List(ctx context.Context, scope, namespace, name string) ([]TemplateRevision, error) {
	return h.repo.List(ctx, scope, namespace, name)
}

func (h *TemplateHistory) Get(ctx context.Context, id string) (TemplateRevision, error) {
	return h.repo.Get(ctx, id)
}
