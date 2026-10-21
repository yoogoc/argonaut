import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { http, query } from "@/lib/http";

import type { Component, List, TemplateRevision, WorkflowTemplate } from "./types";

export type { Component, TemplateRevision };

/**
 * A WorkflowTemplate or a ClusterWorkflowTemplate. The two share every page (DESIGN §5.2); only the
 * URL prefix and the absence of a namespace differ.
 */
export type TemplateRef = { cluster: false; namespace: string; name: string } | { cluster: true; name: string };
export type TemplateScope = { cluster: false; namespace: string } | { cluster: true };

const base = (scope: TemplateScope) => (scope.cluster ? "cluster-workflow-templates" : `workflow-templates/${scope.namespace}`);
const one = (ref: TemplateRef) => (ref.cluster ? `cluster-workflow-templates/${ref.name}` : `workflow-templates/${ref.namespace}/${ref.name}`);

export function refKey(ref: TemplateRef): string[] {
  return ref.cluster ? ["cluster", ref.name] : ["ns", ref.namespace, ref.name];
}

export async function listTemplates(scope: TemplateScope, params: { namePattern?: string; labelSelector?: string; limit?: number; continueToken?: string } = {}) {
  const path = scope.cluster ? "cluster-workflow-templates" : "workflow-templates";
  const reply = await http
    .get(`${path}${query({ namespace: scope.cluster ? undefined : scope.namespace, ...params })}`)
    .json<{ list: List<WorkflowTemplate> }>();
  return reply.list;
}

export async function getTemplate(ref: TemplateRef): Promise<WorkflowTemplate> {
  return (await http.get(one(ref)).json<{ template: WorkflowTemplate }>()).template;
}

export async function createTemplate(scope: TemplateScope, manifest: string, message?: string): Promise<WorkflowTemplate> {
  const path = scope.cluster ? "cluster-workflow-templates" : `workflow-templates/${scope.namespace}`;
  return (await http.post(path, { json: { manifest, message } }).json<{ template: WorkflowTemplate }>()).template;
}

export async function updateTemplate(ref: TemplateRef, manifest: string, message?: string): Promise<WorkflowTemplate> {
  return (await http.put(one(ref), { json: { manifest, message } }).json<{ template: WorkflowTemplate }>()).template;
}

export async function lintTemplate(scope: TemplateScope, manifest: string): Promise<WorkflowTemplate> {
  const path = scope.cluster ? "cluster-workflow-templates-lint" : `${base(scope)}/lint`;
  return (await http.post(path, { json: { manifest } }).json<{ template: WorkflowTemplate }>()).template;
}

export async function deleteTemplate(ref: TemplateRef) {
  await http.delete(one(ref)).json();
}

export async function listRevisions(ref: TemplateRef): Promise<TemplateRevision[]> {
  return (await http.get(`${one(ref)}/revisions`).json<{ revisions: TemplateRevision[] | null }>()).revisions ?? [];
}

export async function getRevision(ref: TemplateRef, id: string): Promise<TemplateRevision> {
  return (await http.get(`${one(ref)}/revisions/${id}`).json<{ revision: TemplateRevision }>()).revision;
}

export async function rollbackTemplate(ref: TemplateRef, id: string, resourceVersion: string): Promise<WorkflowTemplate> {
  return (await http.post(`${one(ref)}/revisions/${id}/rollback`, { json: { resourceVersion } }).json<{ template: WorkflowTemplate }>()).template;
}

export async function listComponents(namespace: string): Promise<Component[]> {
  return (await http.get(`components/${namespace}`).json<{ components: Component[] | null }>()).components ?? [];
}

export const templateQueries = {
  list: (scope: TemplateScope, params: { namePattern?: string; labelSelector?: string } = {}) =>
    queryOptions({
      queryKey: ["templates", "list", scope.cluster ? "cluster" : scope.namespace, params],
      queryFn: () => listTemplates(scope, params),
      placeholderData: keepPreviousData,
    }),
  detail: (ref: TemplateRef) => queryOptions({ queryKey: ["templates", "detail", ...refKey(ref)], queryFn: () => getTemplate(ref) }),
  revisions: (ref: TemplateRef) => queryOptions({ queryKey: ["templates", "revisions", ...refKey(ref)], queryFn: () => listRevisions(ref) }),
  revision: (ref: TemplateRef, id: string) => queryOptions({ queryKey: ["templates", "revision", ...refKey(ref), id], queryFn: () => getRevision(ref, id), staleTime: Infinity }),
  components: (namespace: string) => queryOptions({ queryKey: ["templates", "components", namespace], queryFn: () => listComponents(namespace) }),
};

/** Labels Argo puts on a run created from a template; used to list a template's runs. */
export function runLabelSelector(ref: TemplateRef): string {
  return ref.cluster ? `workflows.argoproj.io/cluster-workflow-template=${ref.name}` : `workflows.argoproj.io/workflow-template=${ref.name}`;
}

export const COMPONENT_LABEL = "argonaut.io/component";
export const LAYOUT_ANNOTATION = "argonaut.io/layout";
export const MODIFIED_BY_ANNOTATION = "argonaut.io/last-modified-by";
