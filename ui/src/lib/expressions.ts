import type { NodeStatus, Parameter, Workflow } from "@/api/types";

import { podName } from "./workflow";

// Renders Argo template variables ({{inputs.parameters.x}}, {{workflow.name}}, {{=expr}}) in a node's
// spec with the values the run used. Values come from three places, best first:
//   - "pod": the template the controller rendered into the node's pod (ARGO_TEMPLATE), matched back
//     against the template as written. Exact, but only while the pod exists.
//   - "run": what the run recorded (inputs, parameters, sibling outputs), resolved in the browser.
//   - "estimate": an expression evaluated by the server with Argo's engine against those recorded
//     values. Usually right, but the controller may have seen different values when it ran.
// Anything else stays marked as unresolved rather than guessed.

export type ValueSource = "pod" | "run" | "estimate";

export type Segment = { text: string } | { raw: string; path: string; value?: string; source?: ValueSource; error?: string };

/** What the 定义 tab knows about one node's values. */
export interface ExpressionScope {
  variables: Record<string, string>;
  /** Template text as written → the value per variable, read from the pod's rendered template. */
  rendered?: Map<string, (string | undefined)[]>;
  /** Expression body → its server-side estimate. */
  estimates?: Map<string, { value?: string; error?: string }>;
}

const VARIABLE = /\{\{\s*(=?)\s*([\s\S]*?)\s*\}\}/g;

/** Splits text into literal runs and template variables. */
function parse(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(VARIABLE)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ raw: m[0], path: m[1] ? `=${m[2]}` : m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Splits text into literal runs and template variables, each resolved as well as the scope allows. */
export function renderTemplate(text: string, scope: ExpressionScope): Segment[] {
  const fromPod = scope.rendered?.get(text);
  let index = 0;
  return parse(text).map((s) => {
    if ("text" in s) return s;
    const i = index++;
    const pod = fromPod?.[i];
    if (pod !== undefined) return { ...s, value: pod, source: "pod" };
    if (s.path.startsWith("=")) {
      const estimate = scope.estimates?.get(s.path.slice(1));
      return estimate?.value !== undefined ? { ...s, value: estimate.value, source: "estimate" } : { ...s, error: estimate?.error };
    }
    const value = scope.variables[s.path];
    return value !== undefined ? { ...s, value, source: "run" } : s;
  });
}

export const hasTemplate = (text?: string) => !!text && /\{\{[\s\S]*?\}\}/.test(text);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Matches rendered text back to the text as written, giving each variable the text it became. The
 * literals between variables anchor the match; two variables with nothing between them cannot be told
 * apart, and a variable the controller left in place ({{…}} still in the output) has no value.
 */
export function alignRendered(text: string, rendered: string): (string | undefined)[] | undefined {
  const segments = parse(text);
  const variables = segments.filter((s) => !("text" in s)).length;
  if (!variables) return undefined;
  let pattern = "^";
  let previousWasVariable = false;
  for (const s of segments) {
    if ("text" in s) {
      pattern += escapeRegExp(s.text);
      previousWasVariable = false;
    } else {
      if (previousWasVariable) return undefined;
      pattern += "([\\s\\S]*?)";
      previousWasVariable = true;
    }
  }
  const m = new RegExp(pattern + "$").exec(rendered);
  if (!m) return undefined;
  return m.slice(1).map((v) => (hasTemplate(v) ? undefined : v));
}

/**
 * Walks the template as written alongside the template as rendered, pairing every string that holds a
 * variable with its rendered counterpart at the same place.
 */
export function renderedBindings(raw: unknown, rendered: unknown, out = new Map<string, (string | undefined)[]>()) {
  if (typeof raw === "string") {
    if (typeof rendered === "string" && hasTemplate(raw) && !out.has(raw)) {
      const values = alignRendered(raw, rendered);
      if (values) out.set(raw, values);
    }
  } else if (Array.isArray(raw)) {
    if (Array.isArray(rendered)) raw.forEach((v, i) => renderedBindings(v, rendered[i], out));
  } else if (raw && typeof raw === "object" && rendered && typeof rendered === "object") {
    for (const [k, v] of Object.entries(raw)) renderedBindings(v, (rendered as Record<string, unknown>)[k], out);
  }
  return out;
}

/** The bodies of every {{=…}} expression in the template that the pod did not already resolve. */
export function pendingExpressions(raw: unknown, rendered?: Map<string, (string | undefined)[]>, out = new Set<string>()): Set<string> {
  if (typeof raw === "string") {
    const fromPod = rendered?.get(raw);
    let index = 0;
    for (const s of parse(raw)) {
      if ("text" in s) continue;
      if (s.path.startsWith("=") && fromPod?.[index] === undefined) out.add(s.path.slice(1));
      index++;
    }
  } else if (Array.isArray(raw)) {
    for (const v of raw) pendingExpressions(v, rendered, out);
  } else if (raw && typeof raw === "object") {
    for (const v of Object.values(raw)) pendingExpressions(v, rendered, out);
  }
  return out;
}

const setParams = (out: Record<string, string>, prefix: string, params: Parameter[] | undefined) => {
  for (const p of params ?? []) if (p.value != null) out[`${prefix}.${p.name}`] = p.value;
};

/**
 * The variables one node of a run could reference, as flat names the way templates write them. The
 * server evaluates expressions against the same map, so what the browser shows and what it estimates
 * agree.
 */
export function expressionVariables(wf: Workflow, node: NodeStatus): Record<string, string> {
  const out: Record<string, string> = {};
  // API objects carry null as well as absent fields; neither is a value.
  const put = (key: string, value: string | null | undefined) => {
    if (value != null) out[key] = String(value);
  };

  setParams(out, "inputs.parameters", node.inputs?.parameters);
  for (const a of node.inputs?.artifacts ?? []) put(`inputs.artifacts.${a.name}.path`, a.path);

  put("workflow.name", wf.metadata.name);
  put("workflow.namespace", wf.metadata.namespace);
  put("workflow.uid", wf.metadata.uid);
  put("workflow.serviceAccountName", wf.spec.serviceAccountName);
  put("workflow.creationTimestamp", wf.metadata.creationTimestamp);
  put("workflow.status", wf.status?.phase);
  put("workflow.mainEntrypoint", wf.spec.entrypoint);
  // The run's parameters: the template's defaults under the submitted values.
  setParams(out, "workflow.parameters", wf.status?.storedWorkflowTemplateSpec?.arguments?.parameters);
  setParams(out, "workflow.parameters", wf.spec.arguments?.parameters);
  for (const [k, v] of Object.entries(wf.metadata.labels ?? {})) put(`workflow.labels.${k}`, v);
  for (const [k, v] of Object.entries(wf.metadata.annotations ?? {})) put(`workflow.annotations.${k}`, v);

  put("pod.name", podName(wf, node));
  put("node.name", node.name);

  const statuses = Object.values(wf.status?.nodes ?? {});
  const retryParent = statuses.find((n) => n.type === "Retry" && n.children?.includes(node.id));
  put("retries", retryParent ? String(Math.max(0, (retryParent.children ?? []).indexOf(node.id))) : "0");

  // A DAG task or step names its siblings: nodes in the same boundary, by display name. A Retry node
  // carries the outputs of its successful attempt, so it is preferred over its attempts.
  const siblings = new Map<string, NodeStatus>();
  for (const n of statuses) {
    if (n.boundaryID !== node.boundaryID || !n.displayName) continue;
    const seen = siblings.get(n.displayName);
    if (!seen || (n.type === "Retry" && seen.type !== "Retry")) siblings.set(n.displayName, n);
  }
  for (const [name, n] of siblings) {
    for (const prefix of [`tasks.${name}`, `steps.${name}`]) {
      put(`${prefix}.outputs.result`, n.outputs?.result);
      put(`${prefix}.outputs.exitCode`, n.outputs?.exitCode);
      setParams(out, `${prefix}.outputs.parameters`, n.outputs?.parameters);
      put(`${prefix}.status`, n.phase);
      put(`${prefix}.id`, n.id);
      put(`${prefix}.startedAt`, n.startedAt);
      put(`${prefix}.finishedAt`, n.finishedAt);
    }
  }
  return out;
}
