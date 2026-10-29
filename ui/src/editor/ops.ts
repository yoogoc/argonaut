import { LAYOUT_ANNOTATION } from "@/api/templates";
import type { WorkflowTemplate } from "@/api/types";
import { findTemplate, type NodeKind, parseDepends, type SpecLike, type SpecTask, type SpecTemplate, type TemplateRefLike } from "@/graph/spec";

import { getIn, type Json, type Path, uniqueName } from "./doc";
import { type Positions, readLayout, specOf, taskPath } from "./store";

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

/**
 * The template new nodes go into. A single-step entry template (a container, script, suspend…) has no
 * tasks to add to, so adding the first step wraps it: a new DAG template becomes the entrypoint, with
 * the old entry as its first task, and the old template keeps everything it had.
 */
export function ensureDag(draft: Json, template: string): string {
  const t = dagOf(draft, template);
  const spec = draft.spec as SpecLike;
  if (t.dag || t.steps || spec.entrypoint !== template) return template;
  const name = uniqueName("main", templates(draft).map((x) => x.name ?? ""));
  templates(draft).push({ name, dag: { tasks: [{ name: template, template }] } });
  spec.entrypoint = name;
  return name;
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
  // Both spellings: tasks.x.outputs… in templates, tasks['x'].status in hook expressions.
  const next = ["tasks", "steps"].reduce((acc, scope) => acc.replaceAll(`${scope}.${from}.`, `${scope}.${to}.`).replaceAll(`${scope}['${from}']`, `${scope}['${to}']`), json);
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

// ---------- lifecycle hooks ----------
//
// Hooks run beside a task or the whole workflow: `exit` when it finishes, any other name when its
// expression turns true. A task's live under task.hooks, the workflow's under spec.hooks; the canvas
// draws both and these operations are its gestures.

/** Whose hooks: a task of a DAG or steps template, or the workflow when undefined. */
export type HookOwner = { template: string; task: string } | undefined;

export type HookTrigger = "running" | "succeeded" | "failed" | "exit" | "custom";

export interface SpecHook {
  expression?: string;
  template?: string;
  templateRef?: TemplateRefLike;
  arguments?: unknown;
  [key: string]: unknown;
}

const PHASE: Record<"running" | "succeeded" | "failed", string> = { running: "Running", succeeded: "Succeeded", failed: "Failed" };

/** The path of the object holding an owner's hooks. */
export function hooksPath(draft: Json, owner: HookOwner): Path | undefined {
  if (!owner) return ["spec", "hooks"];
  const task = taskPath(draft, owner.template, owner.task);
  return task && [...task, "hooks"];
}

function hooksOf(draft: Json, owner: HookOwner, create = false): Record<string, SpecHook> | undefined {
  const path = hooksPath(draft, owner);
  if (!path) return undefined;
  const holder = getIn(draft, path.slice(0, -1)) as Record<string, unknown> | undefined;
  if (!holder) return undefined;
  if (!holder.hooks && create) holder.hooks = {};
  return holder.hooks as Record<string, SpecHook> | undefined;
}

/** The expression a preset trigger stands for: the owner's status reaching that phase. */
export function triggerExpression(draft: Json, owner: HookOwner, trigger: "running" | "succeeded" | "failed"): string {
  if (!owner) return `workflow.status == "${PHASE[trigger]}"`;
  const scope = findTemplate(specOf(draft), owner.template)?.steps ? "steps" : "tasks";
  return `${scope}['${owner.task}'].status == "${PHASE[trigger]}"`;
}

/** Which preset a hook matches, if any. */
export function hookTrigger(draft: Json, owner: HookOwner, event: string, hook: SpecHook | undefined): HookTrigger {
  if (event === "exit") return "exit";
  for (const t of ["running", "succeeded", "failed"] as const) if (hook?.expression?.trim() === triggerExpression(draft, owner, t)) return t;
  return "custom";
}

/** Adds a hook that runs a new container template. Returns its event name. */
export function addHook(draft: Json, owner: HookOwner, trigger: HookTrigger): string {
  const hooks = hooksOf(draft, owner, true);
  if (!hooks) return "";
  const event = trigger === "exit" ? (hooks.exit ? "" : "exit") : uniqueName(trigger === "custom" ? "hook" : trigger, Object.keys(hooks));
  if (!event) return "";
  const tplName = uniqueName(`${owner?.task ?? "workflow"}-${event}`, templates(draft).map((t) => t.name ?? ""));
  templates(draft).push(defaultTemplate("container", tplName));
  hooks[event] = trigger === "exit" ? { template: tplName } : { expression: trigger === "custom" ? "" : triggerExpression(draft, owner, trigger), template: tplName };
  return event;
}

export function deleteHook(draft: Json, owner: HookOwner, event: string) {
  const path = hooksPath(draft, owner);
  const hooks = hooksOf(draft, owner);
  if (!path || !hooks) return;
  delete hooks[event];
  if (!Object.keys(hooks).length) delete (getIn(draft, path.slice(0, -1)) as Record<string, unknown>).hooks;
}

/** Renames a hook's event, keeping its place among the others. Returns false if the name is taken. */
export function renameHook(draft: Json, owner: HookOwner, from: string, to: string): boolean {
  const hooks = hooksOf(draft, owner);
  if (!hooks || !to || from === to || to in hooks || !(from in hooks)) return false;
  const entries = Object.entries(hooks).map(([k, v]) => [k === from ? to : k, v] as const);
  for (const k of Object.keys(hooks)) delete hooks[k];
  for (const [k, v] of entries) hooks[k] = v;
  return true;
}

/**
 * Switches a hook to a preset trigger. `exit` is a name rather than an expression, so switching to or
 * from it renames the hook. Returns the hook's event name afterwards.
 */
export function setHookTrigger(draft: Json, owner: HookOwner, event: string, trigger: HookTrigger): string {
  const hooks = hooksOf(draft, owner);
  const hook = hooks?.[event];
  if (!hooks || !hook) return event;
  let name = event;
  if (trigger === "exit") {
    if (event !== "exit" && renameHook(draft, owner, event, "exit")) name = "exit";
    if (name === "exit") delete hooks.exit.expression;
    return name;
  }
  if (event === "exit") {
    name = uniqueName(trigger === "custom" ? "hook" : trigger, Object.keys(hooks));
    renameHook(draft, owner, event, name);
  }
  hooks[name].expression = trigger === "custom" ? (hooks[name].expression ?? "") : triggerExpression(draft, owner, trigger);
  return name;
}

/** Points a hook at a template of this spec or at a component (templateRef). */
export function setHookTarget(draft: Json, owner: HookOwner, event: string, target: { template: string } | { templateRef: TemplateRefLike }) {
  const hook = hooksOf(draft, owner)?.[event];
  if (!hook) return;
  delete hook.template;
  delete hook.templateRef;
  Object.assign(hook, target);
}
