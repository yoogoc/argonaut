import { http, query } from "@/lib/http";

import type { CronWorkflow, List, Workflow } from "./types";

export interface CronListParams {
  namespace: string;
  namePattern?: string;
  labelSelector?: string;
  limit?: number;
  continueToken?: string;
}

export async function listCronWorkflows(params: CronListParams): Promise<List<CronWorkflow>> {
  const reply = await http
    .get(`cron-workflows${query({ ...params })}`)
    .json<{ list: List<CronWorkflow> }>();
  return reply.list;
}

export async function getCronWorkflow(namespace: string, name: string): Promise<CronWorkflow> {
  const reply = await http
    .get(`cron-workflows/${namespace}/${name}`)
    .json<{ cronWorkflow: CronWorkflow }>();
  return reply.cronWorkflow;
}

export async function createCronWorkflow(
  namespace: string,
  manifest: string,
): Promise<CronWorkflow> {
  const reply = await http
    .post(`cron-workflows/${namespace}`, { json: { namespace, manifest } })
    .json<{ cronWorkflow: CronWorkflow }>();
  return reply.cronWorkflow;
}

export async function updateCronWorkflow(
  namespace: string,
  name: string,
  manifest: string,
): Promise<CronWorkflow> {
  const reply = await http
    .put(`cron-workflows/${namespace}/${name}`, { json: { namespace, name, manifest } })
    .json<{ cronWorkflow: CronWorkflow }>();
  return reply.cronWorkflow;
}

export async function lintCronWorkflow(namespace: string, manifest: string): Promise<CronWorkflow> {
  const reply = await http
    .post(`cron-workflows/${namespace}/lint`, { json: { namespace, manifest } })
    .json<{ cronWorkflow: CronWorkflow }>();
  return reply.cronWorkflow;
}

export async function deleteCronWorkflow(namespace: string, name: string) {
  await http.delete(`cron-workflows/${namespace}/${name}`).json();
}

async function cronAction(namespace: string, name: string, verb: string): Promise<CronWorkflow> {
  const reply = await http
    .put(`cron-workflows/${namespace}/${name}/${verb}`, { json: { namespace, name } })
    .json<{ cronWorkflow: CronWorkflow }>();
  return reply.cronWorkflow;
}

export const suspendCronWorkflow = (namespace: string, name: string) =>
  cronAction(namespace, name, "suspend");

export const resumeCronWorkflow = (namespace: string, name: string) =>
  cronAction(namespace, name, "resume");

/** Triggers one immediate run; Argo has no such API, so the server converts the cron itself. */
export async function runCronWorkflowNow(namespace: string, name: string): Promise<Workflow> {
  const reply = await http
    .post(`cron-workflows/${namespace}/${name}/run`, { json: { namespace, name } })
    .json<{ workflow: Workflow }>();
  return reply.workflow;
}
