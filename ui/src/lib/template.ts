import type { NodeStatus, Template, Workflow } from "@/api/types";

/**
 * Resolves the template a node actually ran.
 *
 * A node's status records only which template it used, not the template itself, and where that
 * definition lives depends on how the workflow was submitted:
 *
 *  - submitted from a WorkflowTemplate, the templates are in `status.storedWorkflowTemplateSpec` and
 *    `spec.templates` is empty, so reading the spec alone finds nothing;
 *  - a template that referenced another one (`templateRef`) is copied into `status.storedTemplates`
 *    under a scope-qualified key.
 *
 * This is a port of Argo's own `getResolvedTemplates`, including the reference walk that merges a
 * chain of referencing templates, because getting any of it wrong silently shows an empty panel.
 */
export function resolveTemplate(workflow: Workflow, node: NodeStatus): Template | undefined {
  const scope = templateScope(node);
  let holder: { template?: string; templateRef?: TemplateRef } = {
    template: node.templateName,
    templateRef: node.templateRef,
  };

  const chain: Template[] = [];
  const maxDepth = 10;

  for (let depth = 0; depth < maxDepth; depth++) {
    const reference = resolveReference(scope, holder);
    let template: Template | undefined;
    if (reference.storageNeeded) {
      template = workflow.status?.storedTemplates?.[reference.storedTemplateName];
    } else if (holder.template) {
      template = execTemplates(workflow).find((t) => t.name === holder.template);
    }
    if (!template) return undefined;

    chain.push(template);
    // A template that names another one is a reference; keep walking until a concrete body is found.
    if (!template.template && !template.templateRef) break;
    holder = { template: template.template, templateRef: template.templateRef };
  }

  // Merge from the innermost outwards so the concrete definition wins, dropping the reference fields
  // that only pointed at the next hop.
  let resolved: Template | undefined;
  for (const template of chain.reverse()) {
    const { template: _ref, templateRef: _refObj, ...body } = template;
    resolved = { ...resolved, ...body } as Template;
  }
  return resolved;
}

type TemplateRef = { name: string; template: string; clusterScope?: boolean };
type Scope = { compatibilityMode: boolean; resourceScope: string; resourceName?: string };

/** An empty or single-segment scope comes from older Argo versions; both are handled as Argo does. */
function templateScope(node: NodeStatus): Scope {
  if (!node.templateScope) {
    return { compatibilityMode: true, resourceScope: "local" };
  }
  const parts = node.templateScope.split("/");
  if (parts.length === 1) {
    return { compatibilityMode: true, resourceScope: "namespaced", resourceName: parts[0] };
  }
  return { compatibilityMode: false, resourceScope: parts[0], resourceName: parts[1] };
}

function resolveReference(
  scope: Scope,
  holder: { template?: string; templateRef?: TemplateRef },
): { storedTemplateName: string; storageNeeded: boolean } {
  if (holder.templateRef) {
    // Calling out to a WorkflowTemplate or ClusterWorkflowTemplate: Argo stored a copy.
    const referenceScope = holder.templateRef.clusterScope ? "cluster" : "namespaced";
    const name = `${holder.templateRef.name}/${holder.templateRef.template}`;
    return {
      storedTemplateName: scope.compatibilityMode ? name : `${referenceScope}/${name}`,
      storageNeeded: true,
    };
  }
  if (scope.resourceScope !== "local") {
    // A template inside a WorkflowTemplate calling a sibling: also stored.
    const name = `${scope.resourceName}/${holder.template}`;
    return {
      storedTemplateName: scope.compatibilityMode ? name : `${scope.resourceScope}/${name}`,
      storageNeeded: true,
    };
  }
  // A workflow calling one of its own templates.
  return { storedTemplateName: "", storageNeeded: false };
}

/**
 * The templates in effect for this run. `status.storedWorkflowTemplateSpec` holds them when the
 * workflow came from a WorkflowTemplate, and `spec` overrides it for a workflow that carries its own.
 */
function execTemplates(workflow: Workflow): Template[] {
  const stored = workflow.status?.storedWorkflowTemplateSpec?.templates ?? [];
  const own = workflow.spec?.templates ?? [];
  return own.length > 0 ? own : stored;
}

/** What kind of work a template describes, which decides which details are worth showing. */
export type TemplateKind = "container" | "script" | "http" | "resource" | "data" | "other";

export function templateKind(template?: Template): TemplateKind {
  if (!template) return "other";
  if (template.script) return "script";
  if (template.container) return "container";
  if (template.containerSet) return "container";
  if (template.http) return "http";
  if (template.resource) return "resource";
  if (template.data) return "data";
  return "other";
}

/** The containers a template runs, including a container set's members and any sidecars. */
export function templateContainers(template?: Template) {
  if (!template) return [];
  const containers = [];
  if (template.container) containers.push({ ...template.container, name: template.container.name || "main" });
  if (template.script) containers.push({ ...template.script, name: template.script.name || "main" });
  for (const c of template.containerSet?.containers ?? []) containers.push(c);
  for (const c of template.sidecars ?? []) containers.push({ ...c, sidecar: true });
  return containers;
}
