import { LAYOUT_ANNOTATION } from "@/api/templates";
import type { WorkflowTemplate } from "@/api/types";
import { type NodeKind, parseDepends, type SpecLike, type SpecTask, type SpecTemplate } from "@/graph/spec";

import { type Json, uniqueName } from "./doc";
import { type Positions, readLayout, specOf } from "./store";

// Edits the editor makes to a template, expressed as immer recipes over the manifest. Each touches
// only what the edit is about (DESIGN §3.1): adding a node adds one task and, when needed, one
// template; connecting two nodes rewrites one `depends`.

/** A sensible starting template for a node kind dragged from the palette. */
export function defaultTemplate(kind: NodeKind, name: string): SpecTemplate {
  switch (kind) {
    case "container":
      return { name, container: { image: "busybox:1.36", command: ["sh", "-c"], args: ["echo hello"] } };
    case "script":
      return { name, script: { image: "python:3.12-slim", command: ["python"], source: 'print("hello")\n' } };
    case "containerSet":
      return { name, containerSet: { containers: [{ name: "main", image: "busybox:1.36", command: ["sh", "-c"], args: ["echo main"] }] } };
    case "resource":
      return { name, resource: { action: "create", manifest: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  generateName: example-\ndata:\n  key: value\n" } };
    case "http":
      return { name, http: { method: "GET", url: "https://example.com", timeoutSeconds: 30 } };
    case "data":
      return { name, data: { source: { artifactPaths: { name: "source", s3: { key: "" } } }, transformation: [{ expression: "filter(data, {# endsWith \".json\"})" }] } };
    case "plugin":
      return { name, plugin: { hello: {} } };
    case "suspend":
      return { name, suspend: {} };
    case "dag":
      return { name, dag: { tasks: [] } };
    case "steps":
      return { name, steps: [] };
    default:
      return { name, container: { image: "busybox:1.36" } };
  }
}

function templates(draft: Json): SpecTemplate[] {
  const spec = (draft.spec ??= {}) as SpecLike;
  return (spec.templates ??= []);
}

function dagOf(draft: Json, template: string) {
  const t = templates(draft).find((x) => x.name === template);
  if (!t) throw new Error(`template ${template} not found`);
  return t;
}

function allTaskNames(t: SpecTemplate): string[] {
  if (t.dag) return (t.dag.tasks ?? []).map((x) => x.name);
  if (t.steps) return t.steps.flat().map((x) => x.name);
  return [];
}

function setPosition(draft: Json, template: string, task: string, pos?: [number, number]) {
  const layout = readLayout(draft);
  layout[template] ??= {};
  if (pos) layout[template][task] = [Math.round(pos[0]), Math.round(pos[1])];
  else delete layout[template][task];
  const meta = ((draft.metadata ??= {}) as Json);
  const annotations = ((meta.annotations ??= {}) as Record<string, string>);
  annotations[LAYOUT_ANNOTATION] = JSON.stringify(layout);
}

/** Adds a node of a basic kind: a new template plus a task that runs it. Returns the task name. */
export function addKindNode(draft: Json, canvasTemplate: string, kind: NodeKind, pos?: [number, number]): string {
  const owner = dagOf(draft, canvasTemplate);
  const taskName = uniqueName(kind === "containerSet" ? "container-set" : kind, allTaskNames(owner));
  const tplName = uniqueName(taskName, templates(draft).map((t) => t.name ?? ""));
  templates(draft).push(defaultTemplate(kind, tplName));
  addTask(owner, { name: taskName, template: tplName });
  if (pos) setPosition(draft, canvasTemplate, taskName, pos);
  return taskName;
}

/**
 * Adds a component (DESIGN §3.3). By reference the task points at it with templateRef and follows its
 * updates; as a snapshot its templates are copied in (renamed if they collide), which pins the version.
 */
export function addComponentNode(draft: Json, canvasTemplate: string, component: WorkflowTemplate, cluster: boolean, mode: "ref" | "snapshot", pos?: [number, number]): string {
  const owner = dagOf(draft, canvasTemplate);
  const entry = component.spec.entrypoint ?? component.spec.templates?.[0]?.name ?? "";
  const taskName = uniqueName(component.metadata.name, allTaskNames(owner));
  if (mode === "ref") {
    addTask(owner, { name: taskName, templateRef: { name: component.metadata.name, template: entry, ...(cluster ? { clusterScope: true } : {}) } });
  } else {
    const taken = new Set(templates(draft).map((t) => t.name ?? ""));
    const renames = new Map<string, string>();
    for (const t of component.spec.templates ?? []) {
      const name = t.name ?? "";
      const next = taken.has(name) ? uniqueName(`${component.metadata.name}-${name}`, taken) : name;
      renames.set(name, next);
      taken.add(next);
    }
    for (const t of component.spec.templates ?? []) {
      const copy = structuredClone(t) as SpecTemplate;
      copy.name = renames.get(t.name ?? "");
      // Internal references between the component's own templates follow the renames.
      for (const task of copy.dag?.tasks ?? []) if (task.template && renames.has(task.template)) task.template = renames.get(task.template);
      for (const step of copy.steps?.flat() ?? []) if (step.template && renames.has(step.template)) step.template = renames.get(step.template);
      templates(draft).push(copy);
    }
    addTask(owner, { name: taskName, template: renames.get(entry) ?? entry });
  }
  if (pos) setPosition(draft, canvasTemplate, taskName, pos);
  return taskName;
}

function addTask(owner: SpecTemplate, task: SpecTask) {
  if (owner.dag) (owner.dag.tasks ??= []).push(task);
  else if (owner.steps) owner.steps.push([task]);
}

/** Adds `source` to target's dependencies, keeping whichever syntax the task already uses. */
export function connect(draft: Json, template: string, source: string, target: string, condition?: string) {
  const owner = dagOf(draft, template);
  const task = owner.dag?.tasks?.find((x) => x.name === target);
  if (!task || source === target) return;
  const term = condition ? `${source}.${condition}` : source;
  if (parseDepends(task.depends).some((d) => d.task === source) || task.dependencies?.includes(source)) return;
  if (task.dependencies && !task.depends) {
    task.dependencies.push(source);
    return;
  }
  task.depends = task.depends ? `${task.depends.includes("||") ? `(${task.depends})` : task.depends} && ${term}` : term;
}

/** Removes `source` from target's dependencies, editing the expression as little as possible. */
export function disconnect(draft: Json, template: string, source: string, target: string) {
  const owner = dagOf(draft, template);
  const task = owner.dag?.tasks?.find((x) => x.name === target);
  if (!task) return;
  if (task.dependencies) {
    task.dependencies = task.dependencies.filter((d) => d !== source);
    if (!task.dependencies.length) delete task.dependencies;
  }
  if (task.depends) {
    const next = removeTerm(task.depends, source);
    if (next) task.depends = next;
    else delete task.depends;
  }
}

/** Removes every occurrence of a task (with any .Condition) from a depends expression. */
export function removeTerm(expression: string, task: string): string {
  const name = task.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  let out = expression
    .replace(new RegExp(`(?:&&|\\|\\|)\\s*!?\\s*${name}(?:\\.[A-Za-z]+)?(?![\\w.-])`, "g"), "")
    .replace(new RegExp(`!?\\s*${name}(?:\\.[A-Za-z]+)?(?![\\w.-])\\s*(?:&&|\\|\\|)?`, "g"), "");
  out = out.replace(/\(\s*\)/g, "").replace(/\(\s*(&&|\|\|)/g, "(").replace(/(&&|\|\|)\s*\)/g, ")").replace(/^\s*(&&|\|\|)\s*|\s*(&&|\|\|)\s*$/g, "");
  return out.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
}

/** Deletes a task and every reference to it from the other tasks' dependencies. */
export function deleteTask(draft: Json, template: string, name: string) {
  const owner = dagOf(draft, template);
  if (owner.dag) {
    owner.dag.tasks = (owner.dag.tasks ?? []).filter((x) => x.name !== name);
    for (const t of owner.dag.tasks) {
      if (parseDepends(t.depends).some((d) => d.task === name) || t.dependencies?.includes(name)) disconnect(draft, template, name, t.name);
    }
  }
  if (owner.steps) owner.steps = owner.steps.map((g) => g.filter((x) => x.name !== name)).filter((g) => g.length);
  setPosition(draft, template, name, undefined);
}

/** Renames a task and rewrites every reference to it (depends, dependencies, tasks.X expressions). */
export function renameTask(draft: Json, template: string, from: string, to: string) {
  const owner = dagOf(draft, template);
  if (!to || from === to || allTaskNames(owner).includes(to)) return false;
  const re = new RegExp(`(?<![\\w-])${from.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(?![\\w-])`, "g");
  for (const t of owner.dag?.tasks ?? []) {
    if (t.name === from) t.name = to;
    if (t.depends) t.depends = t.depends.replace(re, to);
    if (t.dependencies) t.dependencies = t.dependencies.map((d) => (d === from ? to : d));
    rewriteTaskExpressions(t, from, to);
  }
  for (const s of owner.steps?.flat() ?? []) {
    if (s.name === from) s.name = to;
    rewriteTaskExpressions(s, from, to);
  }
  const layout = readLayout(draft);
  if (layout[template]?.[from]) {
    setPosition(draft, template, to, layout[template][from]);
    setPosition(draft, template, from, undefined);
  }
  return true;
}

function rewriteTaskExpressions(task: SpecTask, from: string, to: string) {
  const json = JSON.stringify(task);
  const next = json.replaceAll(`tasks.${from}.`, `tasks.${to}.`).replaceAll(`steps.${from}.`, `steps.${to}.`);
  if (next !== json) Object.assign(task, JSON.parse(next));
}

export function moveNodes(draft: Json, template: string, moves: Record<string, [number, number]>) {
  for (const [name, pos] of Object.entries(moves)) setPosition(draft, template, name, pos);
}

/** Converts a component reference into an inline snapshot of the component (DESIGN §3.3). */
export function snapshotRef(draft: Json, template: string, task: string, component: WorkflowTemplate, cluster: boolean) {
  const owner = dagOf(draft, template);
  const index = owner.dag?.tasks?.findIndex((x) => x.name === task) ?? -1;
  if (index < 0) return;
  const original = owner.dag!.tasks![index];
  const tmp = { metadata: {}, spec: { templates: [] } } as unknown as Json;
  // Reuse the component insertion on a scratch template to get the renamed copies.
  (tmp.spec as SpecLike).templates = structuredClone(templates(draft));
  (tmp.spec as SpecLike).templates!.push({ name: "__scratch__", dag: { tasks: [] } });
  const added = addComponentNode(tmp, "__scratch__", component, cluster, "snapshot");
  const scratch = (tmp.spec as SpecLike).templates!.find((t) => t.name === "__scratch__")!;
  const copied = (tmp.spec as SpecLike).templates!.filter((t) => t.name !== "__scratch__" && !templates(draft).some((x) => x.name === t.name));
  templates(draft).push(...copied);
  const entry = scratch.dag!.tasks!.find((x) => x.name === added)!.template;
  delete original.templateRef;
  original.template = entry;
}

export function positionsOf(obj: Json, template: string): Positions[string] {
  return readLayout(obj)[template] ?? {};
}

export { specOf };
