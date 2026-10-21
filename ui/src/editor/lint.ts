import type { ValidateFunction } from "ajv";
import Ajv from "ajv/dist/2020";

import argoSchema from "@/api/gen/argo-schema.json";
import type { Component } from "@/api/templates";
import { findTemplate, parseDepends, type SpecLike } from "@/graph/spec";

import type { Json } from "./doc";
import { referenceProblems } from "./expressions";

// Local lint (DESIGN §5.4, "校验分两层"): instant, on every edit. The server's lint (Argo's own
// validation, with templateRefs resolved against the cluster) runs on demand and before saving.

export interface Problem {
  /** Canvas node the problem belongs to: a task name, "exit:<template>", or undefined for the spec. */
  node?: string;
  /** Template the node is in. */
  template?: string;
  message: string;
  source: "schema" | "structure" | "reference" | "server";
}

let validators: Record<string, ValidateFunction> | undefined;

type Schema = { definitions?: Record<string, Record<string, unknown>> };

/**
 * The published schema leaves objects open, but Argo's server decodes strictly: an unknown field is a
 * save error there. Closing every object that lists its properties catches typos here first.
 */
function closed(schema: Schema): Schema {
  const definitions: Schema["definitions"] = {};
  for (const [name, def] of Object.entries(schema.definitions ?? {})) {
    // IntOrString and Quantity are typed as strings but decode plain numbers too (limit: 3, cpu: 1).
    if (name.endsWith("intstr.IntOrString") || name.endsWith("resource.Quantity")) {
      definitions[name] = { ...def, type: ["string", "number"] };
      continue;
    }
    definitions[name] = def.properties && def.additionalProperties === undefined && !def["x-kubernetes-preserve-unknown-fields"] ? { ...def, additionalProperties: false } : def;
  }
  return { ...schema, definitions };
}

function validator(kind: "WorkflowTemplate" | "ClusterWorkflowTemplate"): ValidateFunction {
  if (!validators) {
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    ajv.addSchema({ ...closed(argoSchema as Schema), $id: "argo" });
    validators = {
      WorkflowTemplate: ajv.getSchema("argo#/definitions/io.argoproj.workflow.v1alpha1.WorkflowTemplate")!,
      ClusterWorkflowTemplate: ajv.getSchema("argo#/definitions/io.argoproj.workflow.v1alpha1.ClusterWorkflowTemplate")!,
    };
  }
  return validators[kind];
}

/** Which canvas node a JSON path inside the manifest belongs to. */
function nodeForPath(spec: SpecLike, path: string[]): { node?: string; template?: string } {
  if (path[0] !== "spec" || path[1] !== "templates" || path[2] === undefined) return {};
  const tpl = spec.templates?.[Number(path[2])];
  if (!tpl) return {};
  if (path[3] === "dag" && path[4] === "tasks" && path[5] !== undefined) return { node: tpl.dag?.tasks?.[Number(path[5])]?.name, template: tpl.name };
  if (path[3] === "steps" && path[5] !== undefined) return { node: tpl.steps?.[Number(path[4])]?.[Number(path[5])]?.name, template: tpl.name };
  // A problem in a template belongs to every task that runs it; the caller fans it out.
  return { template: tpl.name, node: `template:${tpl.name}` };
}

export function lintLocal(obj: Json, cluster: boolean, components: Component[]): Problem[] {
  const spec = (obj.spec ?? {}) as SpecLike;
  const problems: Problem[] = [];
  const validate = validator(cluster ? "ClusterWorkflowTemplate" : "WorkflowTemplate");
  const candidate = { apiVersion: "argoproj.io/v1alpha1", kind: cluster ? "ClusterWorkflowTemplate" : "WorkflowTemplate", ...obj };
  if (!validate(candidate)) {
    for (const e of validate.errors ?? []) {
      // oneOf/anyOf noise duplicates the concrete error; keep the specific ones.
      if (e.keyword === "oneOf" || e.keyword === "anyOf" || e.keyword === "if") continue;
      const path = e.instancePath.split("/").filter(Boolean);
      const where = nodeForPath(spec, path);
      const field = path.slice(where.node && !where.node.startsWith("template:") ? 6 : 3).join(".");
      const detail = e.keyword === "additionalProperties" ? `unknown field ${String((e.params as { additionalProperty?: string }).additionalProperty)}` : e.message;
      problems.push({ ...where, message: `${field ? `${field}: ` : ""}${detail}`, source: "schema" });
    }
  }

  if (!spec.entrypoint) problems.push({ message: "spec.entrypoint is not set", source: "structure" });
  else if (!findTemplate(spec, spec.entrypoint)) problems.push({ message: `entrypoint ${spec.entrypoint} is not a template of this spec`, source: "structure" });
  if (spec.onExit && !findTemplate(spec, spec.onExit)) problems.push({ node: `exit:${spec.onExit}`, message: `onExit names ${spec.onExit}, which is not a template of this spec`, source: "structure" });

  const names = new Set<string>();
  for (const t of spec.templates ?? []) {
    if (t.name && names.has(t.name)) problems.push({ template: t.name, message: `template name ${t.name} is used twice`, source: "structure" });
    if (t.name) names.add(t.name);
  }
  for (const t of spec.templates ?? []) {
    const tasks = t.dag?.tasks ?? t.steps?.flat() ?? [];
    const taskNames = new Set<string>();
    for (const task of tasks) {
      if (taskNames.has(task.name)) problems.push({ node: task.name, template: t.name, message: `task name ${task.name} is used twice`, source: "structure" });
      taskNames.add(task.name);
      if (!task.templateRef && !task.inline && task.template && !names.has(task.template)) problems.push({ node: task.name, template: t.name, message: `runs template ${task.template}, which is not defined`, source: "structure" });
      if (!task.templateRef && !task.inline && !task.template) problems.push({ node: task.name, template: t.name, message: "runs no template", source: "structure" });
    }
    if (t.dag) {
      for (const task of t.dag.tasks ?? []) {
        const deps = task.depends ? parseDepends(task.depends).map((d) => d.task) : (task.dependencies ?? []);
        for (const d of deps) if (!taskNames.has(d)) problems.push({ node: task.name, template: t.name, message: `depends on ${d}, which is not a task of ${t.name}`, source: "structure" });
      }
      const cycle = findCycle(t.dag.tasks ?? []);
      if (cycle) problems.push({ node: cycle[0], template: t.name, message: `dependency cycle: ${cycle.join(" → ")}`, source: "structure" });
    }
  }

  for (const p of referenceProblems(spec, components)) problems.push({ node: p.task, template: p.template, message: p.message, source: "reference" });
  return problems;
}

function findCycle(tasks: { name: string; depends?: string; dependencies?: string[] }[]): string[] | undefined {
  const deps = new Map(tasks.map((t) => [t.name, t.depends ? parseDepends(t.depends).map((d) => d.task) : (t.dependencies ?? [])]));
  const state = new Map<string, number>();
  const stack: string[] = [];
  const visit = (n: string): string[] | undefined => {
    if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
    if (state.get(n) === 2) return undefined;
    state.set(n, 1);
    stack.push(n);
    for (const d of deps.get(n) ?? []) {
      const found = deps.has(d) ? visit(d) : undefined;
      if (found) return found;
    }
    stack.pop();
    state.set(n, 2);
    return undefined;
  };
  for (const n of deps.keys()) {
    const c = visit(n);
    if (c) return c;
  }
  return undefined;
}

/** Problems keyed by canvas node; a template-level problem is shown on every task that runs it. */
export function problemsByNode(spec: SpecLike, problems: Problem[], canvasTemplate?: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const push = (id: string, m: string) => (out[id] ??= []).push(m);
  const current = findTemplate(spec, canvasTemplate ?? spec.entrypoint);
  const tasks = current?.dag?.tasks ?? current?.steps?.flat() ?? [];
  for (const p of problems) {
    if (p.node?.startsWith("template:")) {
      const name = p.node.slice(9);
      for (const t of tasks) if (t.template === name) push(t.name, p.message);
      if (spec.onExit === name) push(`exit:${name}`, p.message);
    } else if (p.node && (p.template === (canvasTemplate ?? spec.entrypoint) || p.node.startsWith("exit:"))) push(p.node, p.message);
  }
  return out;
}

/** Best-effort mapping of an Argo lint error onto a node: its messages name templates and tasks. */
export function serverProblem(message: string, spec: SpecLike): Problem {
  const task = message.match(/tasks\.([A-Za-z0-9-]+)/)?.[1] ?? message.match(/task "?([A-Za-z0-9-]+)"?/)?.[1];
  const template = message.match(/templates\.([A-Za-z0-9-]+)/)?.[1];
  if (task) {
    const owner = (spec.templates ?? []).find((t) => t.dag?.tasks?.some((x) => x.name === task) || t.steps?.flat().some((x) => x.name === task));
    return { node: task, template: owner?.name, message, source: "server" };
  }
  if (template) return { node: `template:${template}`, template, message, source: "server" };
  return { message, source: "server" };
}
