package biz

import (
	"argonaut/internal/authz"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
)

// Permissions are granted on templates (or wider scopes), so every other resource is attributed to
// the scope that governs it (DESIGN §4.4):
//
//   - a run of a WorkflowTemplate belongs to that template;
//   - a run with no template lineage belongs to its namespace;
//   - a run of a ClusterWorkflowTemplate belongs to its namespace too. Cluster templates are shared
//     pipelines that teams run in their own namespaces; if a grant on the cluster template covered its
//     runs, one grant would reach into every namespace.

// WorkflowResource returns the authz scope of a workflow.
func WorkflowResource(wf *wfv1.Workflow) authz.Resource {
	if wf == nil {
		return authz.Resource{}
	}
	return authz.Resource{Namespace: wf.Namespace, Template: workflowTemplateName(wf), Labels: wf.Labels}
}

func workflowTemplateName(wf *wfv1.Workflow) string {
	// spec.workflowTemplateRef is authoritative: it is what Argo actually resolves at runtime.
	if ref := wf.Spec.WorkflowTemplateRef; ref != nil {
		if ref.ClusterScope {
			return ""
		}
		if ref.Name != "" {
			return ref.Name
		}
	}
	if wf.Labels[common.LabelKeyClusterWorkflowTemplate] != "" {
		return ""
	}
	// Workflows submitted from a template carry this label even when the spec was inlined. argonaut
	// rewrites it on every workflow it creates (see sanitizeLineage), so it cannot be forged through
	// argonaut to borrow another template's grants.
	return wf.Labels[common.LabelKeyWorkflowTemplate]
}

// CronWorkflowResource returns the authz scope of a cron workflow.
func CronWorkflowResource(cron *wfv1.CronWorkflow) authz.Resource {
	if cron == nil {
		return authz.Resource{}
	}
	template := ""
	if ref := cron.Spec.WorkflowSpec.WorkflowTemplateRef; ref != nil && !ref.ClusterScope && ref.Name != "" {
		template = ref.Name
	}
	return authz.Resource{Namespace: cron.Namespace, Template: template, Labels: cron.Labels}
}

// TemplateResource returns the authz scope of a workflow template.
func TemplateResource(namespace, name string) authz.Resource {
	return authz.Resource{Namespace: namespace, Template: name}
}

// TemplateObjectResource includes the template's labels for custom policies.
func TemplateObjectResource(t *wfv1.WorkflowTemplate) authz.Resource {
	return authz.Resource{Namespace: t.Namespace, Template: t.Name, Labels: t.Labels}
}

// ClusterTemplateResource returns the authz scope of a cluster workflow template.
func ClusterTemplateResource(name string) authz.Resource {
	return authz.Resource{ClusterTemplate: name}
}

// NamespaceResource is the scope for namespace-level actions such as creating.
func NamespaceResource(namespace string) authz.Resource {
	return authz.Resource{Namespace: namespace}
}

// sanitizeLineage removes the labels that attribute a workflow to a template before argonaut creates
// it from a raw manifest. Without this, a user with a namespace grant elsewhere — or none — could
// label their manifest with a template they operate and have the run inherit that template's scope.
func sanitizeLineage(wf *wfv1.Workflow) {
	delete(wf.Labels, common.LabelKeyWorkflowTemplate)
	delete(wf.Labels, common.LabelKeyClusterWorkflowTemplate)
	delete(wf.Labels, common.LabelKeyCronWorkflow)
}
