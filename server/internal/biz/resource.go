package biz

import (
	"argonaut/internal/authz"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
)

// Permissions are granted on WorkflowTemplates, so every other resource has to be attributed back to
// the template it came from. A resource with no template lineage falls back to a namespace-only
// scope, which only namespace-wide grants ("*") cover — a grant on one template never leaks to
// unrelated runs in the same namespace.

// WorkflowResource returns the authz scope of a workflow.
func WorkflowResource(wf *wfv1.Workflow) authz.Resource {
	if wf == nil {
		return authz.Resource{}
	}
	return authz.Resource{Namespace: wf.Namespace, Template: workflowTemplateName(wf)}
}

func workflowTemplateName(wf *wfv1.Workflow) string {
	// spec.workflowTemplateRef is authoritative: it is what Argo actually resolves at runtime.
	// ClusterWorkflowTemplates are out of scope, and attributing one to a same-named namespaced
	// template would grant access across a boundary the cluster template does not respect.
	if ref := wf.Spec.WorkflowTemplateRef; ref != nil && !ref.ClusterScope && ref.Name != "" {
		return ref.Name
	}
	// Workflows submitted from a template carry this label even when the spec was inlined.
	if name := wf.Labels[common.LabelKeyWorkflowTemplate]; name != "" {
		return name
	}
	return ""
}

// CronWorkflowResource returns the authz scope of a cron workflow.
func CronWorkflowResource(cron *wfv1.CronWorkflow) authz.Resource {
	if cron == nil {
		return authz.Resource{}
	}
	template := ""
	if ref := cron.Spec.WorkflowSpec.WorkflowTemplateRef; ref != nil && !ref.ClusterScope && ref.Name != "" {
		template = ref.Name
	} else if name := cron.Labels[common.LabelKeyWorkflowTemplate]; name != "" {
		template = name
	}
	return authz.Resource{Namespace: cron.Namespace, Template: template}
}

// TemplateResource returns the authz scope of a workflow template.
func TemplateResource(namespace, name string) authz.Resource {
	return authz.Resource{Namespace: namespace, Template: name}
}

// NamespaceResource is the scope for namespace-level actions such as listing or creating.
func NamespaceResource(namespace string) authz.Resource {
	return authz.Resource{Namespace: namespace}
}
