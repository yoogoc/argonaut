import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { http, query } from "@/lib/http";
import { streamEvents } from "@/lib/sse";

import type {
  List,
  LogEntry,
  Workflow,
  WorkflowEvent,
  WorkflowWatchEvent,
} from "./types";

export interface WorkflowListParams {
  namespace: string;
  namePattern?: string;
  labelSelector?: string;
  phases?: string[];
  /** Run-parameter filter terms: name=value, name~text or name. */
  parameters?: string[];
  /** Source templates: a WorkflowTemplate name, or cluster/<name>. */
  templates?: string[];
  createdAfter?: string;
  finishedBefore?: string;
  limit?: number;
  continueToken?: string;
}

export async function listWorkflows(params: WorkflowListParams): Promise<List<Workflow>> {
  const reply = await http
    .get(`workflows${query({ ...params })}`)
    .json<{ list: List<Workflow> }>();
  return reply.list;
}

export async function getWorkflow(
  namespace: string,
  name: string,
  fields?: string,
): Promise<Workflow> {
  const reply = await http
    .get(`workflows/${namespace}/${name}${query({ fields })}`)
    .json<{ workflow: Workflow }>();
  return reply.workflow;
}

/**
 * The fields a list view needs, so a namespace-wide watch does not stream every workflow in full.
 * Node status dominates a workflow object and no list renders it; on a busy namespace the untrimmed
 * stream is megabytes per second per open tab.
 *
 * `spec.workflowTemplateRef` and the labels inside `metadata` are required, not cosmetic: the server
 * authorizes each event against the template the workflow came from, and it can only see the fields
 * it was asked to send.
 */
export const LIST_WATCH_FIELDS = [
  "result.object.metadata",
  "result.object.spec.workflowTemplateRef",
  "result.object.spec.arguments",
  "result.object.status.phase",
  "result.object.status.message",
  "result.object.status.startedAt",
  "result.object.status.finishedAt",
  "result.object.status.progress",
].join(",");

/** Streams status updates for one workflow, or the whole namespace when name is omitted. */
export function watchWorkflows(
  namespace: string,
  options: {
    name?: string;
    labelSelector?: string;
    /** Trims each event; omit to receive whole workflows, which a detail view needs. */
    fields?: string;
    onWorkflow: (wf: Workflow, type: WorkflowWatchEvent["type"]) => void;
    onError?: (e: unknown) => void;
  },
) {
  return streamEvents<WorkflowWatchEvent>(
    `watch/workflows/${namespace}${query({
      name: options.name,
      labelSelector: options.labelSelector,
      fields: options.fields,
    })}`,
    {
      onMessage: (event) => {
        if (!event.workflowJson) return;
        options.onWorkflow(JSON.parse(event.workflowJson) as Workflow, event.type);
      },
      onError: options.onError,
    },
  );
}

export function watchWorkflowEvents(
  namespace: string,
  name: string,
  options: { onEvent: (event: WorkflowEvent) => void; onError?: (e: unknown) => void },
) {
  return streamEvents<WorkflowEvent>(`workflows/${namespace}/${name}/events`, {
    onMessage: options.onEvent,
    onError: options.onError,
  });
}

export interface LogParams {
  podName?: string;
  nodeId?: string;
  container?: string;
  grep?: string;
  follow?: boolean;
  tailLines?: number;
  timestamps?: boolean;
}

export function streamLogs(
  namespace: string,
  name: string,
  params: LogParams,
  options: { onEntry: (entry: LogEntry) => void; onError?: (e: unknown) => void; onOpen?: () => void; onClose?: () => void; retry?: boolean },
) {
  return streamEvents<LogEntry>(`workflows/${namespace}/${name}/log${query({ ...params })}`, {
    onMessage: options.onEntry,
    onError: options.onError,
    onOpen: options.onOpen,
    onClose: options.onClose,
    retry: options.retry,
  });
}

export interface SubmitParams {
  resourceKind: "WorkflowTemplate" | "ClusterWorkflowTemplate" | "CronWorkflow";
  resourceName: string;
  entryPoint?: string;
  parameters?: string[];
  labels?: string[];
  generateName?: string;
  serviceAccount?: string;
  dryRun?: boolean;
}

export async function submitWorkflow(namespace: string, params: SubmitParams): Promise<Workflow> {
  const reply = await http
    .post(`workflows/${namespace}/submit`, { json: { namespace, ...params } })
    .json<{ workflow: Workflow }>();
  return reply.workflow;
}

export async function createWorkflow(
  namespace: string,
  manifest: string,
  dryRun = false,
): Promise<Workflow> {
  const reply = await http
    .post(`workflows/${namespace}`, { json: { namespace, manifest, dryRun } })
    .json<{ workflow: Workflow }>();
  return reply.workflow;
}

export async function lintWorkflow(namespace: string, manifest: string): Promise<Workflow> {
  const reply = await http
    .post(`workflows/${namespace}/lint`, { json: { namespace, manifest } })
    .json<{ workflow: Workflow }>();
  return reply.workflow;
}

async function action<T = Workflow>(
  namespace: string,
  name: string,
  verb: string,
  body: object = {},
): Promise<T> {
  const reply = await http
    .put(`workflows/${namespace}/${name}/${verb}`, { json: { namespace, name, ...body } })
    .json<{ workflow: T }>();
  return reply.workflow;
}

export interface RetryOptions {
  restartSuccessful?: boolean;
  nodeFieldSelector?: string;
  parameters?: string[];
}

export const retryWorkflow = (namespace: string, name: string, options: RetryOptions = {}) =>
  action(namespace, name, "retry", options);

export const resubmitWorkflow = (
  namespace: string,
  name: string,
  options: { memoized?: boolean; parameters?: string[] } = {},
) => action(namespace, name, "resubmit", options);

export const suspendWorkflow = (namespace: string, name: string) =>
  action(namespace, name, "suspend");

export const resumeWorkflow = (namespace: string, name: string, nodeFieldSelector?: string) =>
  action(namespace, name, "resume", { nodeFieldSelector });

/**
 * Writes a suspended node's output parameters. The official "resume with inputs" flow is this
 * followed by resume: Set records the values, resume releases the node.
 */
export const setWorkflowNode = (
  namespace: string,
  name: string,
  nodeFieldSelector: string,
  outputParameters: Record<string, string>,
) =>
  action(namespace, name, "set", {
    nodeFieldSelector,
    outputParameters: JSON.stringify(outputParameters),
  });

export const stopWorkflow = (
  namespace: string,
  name: string,
  options: { nodeFieldSelector?: string; message?: string } = {},
) => action(namespace, name, "stop", options);

export const terminateWorkflow = (namespace: string, name: string) =>
  action(namespace, name, "terminate");

export async function deleteWorkflow(namespace: string, name: string, force = false) {
  await http.delete(`workflows/${namespace}/${name}${query({ force })}`).json();
}

/** Artifacts are downloaded by navigating to these URLs, which stream from the object store. */
export function artifactUrl(
  namespace: string,
  name: string,
  nodeId: string,
  artifactName: string,
  isInput = false,
) {
  const prefix = isInput ? "input-artifacts" : "artifacts";
  return `/api/v1/${prefix}/${namespace}/${name}/${nodeId}/${encodeURIComponent(artifactName)}`;
}

export const workflowQueries = {
  list: (params: WorkflowListParams) =>
    queryOptions({
      queryKey: ["workflows", "list", params],
      queryFn: () => listWorkflows(params),
      placeholderData: keepPreviousData,
    }),
  detail: (namespace: string, name: string) =>
    queryOptions({
      queryKey: ["workflows", "detail", namespace, name],
      queryFn: () => getWorkflow(namespace, name),
    }),
};

/** A node's template as the controller rendered it into its pod; `templateJson` is empty once the pod is gone. */
export function getRenderedTemplate(
  namespace: string,
  name: string,
  nodeId: string,
): Promise<{ podName?: string; templateJson?: string }> {
  return http
    .get(`workflows/${namespace}/${name}/nodes/${encodeURIComponent(nodeId)}/rendered-template`)
    .json();
}

/** Evaluates {{=…}} expression bodies with Argo's engine against the given flat variables. */
export async function evaluateExpressions(
  expressions: string[],
  variables: Record<string, string>,
): Promise<{ value?: string; error?: string }[]> {
  const reply = await http
    .post("expressions/evaluate", { json: { expressions, variables } })
    .json<{ results?: { value?: string; error?: string }[] }>();
  return reply.results ?? [];
}
