import { http, query } from "@/lib/http";

import type { List, WorkflowTemplate } from "./types";

export interface TemplateListParams {
  namespace: string;
  namePattern?: string;
  labelSelector?: string;
  limit?: number;
  continueToken?: string;
}

export async function listTemplates(params: TemplateListParams): Promise<List<WorkflowTemplate>> {
  const reply = await http
    .get(`workflow-templates${query({ ...params })}`)
    .json<{ list: List<WorkflowTemplate> }>();
  return reply.list;
}

export async function getTemplate(namespace: string, name: string): Promise<WorkflowTemplate> {
  const reply = await http
    .get(`workflow-templates/${namespace}/${name}`)
    .json<{ template: WorkflowTemplate }>();
  return reply.template;
}

export async function createTemplate(
  namespace: string,
  manifest: string,
): Promise<WorkflowTemplate> {
  const reply = await http
    .post(`workflow-templates/${namespace}`, { json: { namespace, manifest } })
    .json<{ template: WorkflowTemplate }>();
  return reply.template;
}

export async function updateTemplate(
  namespace: string,
  name: string,
  manifest: string,
): Promise<WorkflowTemplate> {
  const reply = await http
    .put(`workflow-templates/${namespace}/${name}`, { json: { namespace, name, manifest } })
    .json<{ template: WorkflowTemplate }>();
  return reply.template;
}

export async function lintTemplate(namespace: string, manifest: string): Promise<WorkflowTemplate> {
  const reply = await http
    .post(`workflow-templates/${namespace}/lint`, { json: { namespace, manifest } })
    .json<{ template: WorkflowTemplate }>();
  return reply.template;
}

export async function deleteTemplate(namespace: string, name: string) {
  await http.delete(`workflow-templates/${namespace}/${name}`).json();
}
