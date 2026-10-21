// Projects an Argo spec onto a graph (DESIGN §3.1–3.2). The spec stays the model: this module only
// reads it. The editor writes changes back as patches (editor/store.ts), never by regenerating the
// spec from this graph, so fields the editor does not know about survive.

export type NodeKind = "container" | "script" | "containerSet" | "resource" | "http" | "data" | "plugin" | "suspend" | "dag" | "steps" | "ref" | "unknown";

export interface SpecTemplate {
  name?: string;
  container?: unknown;
  script?: unknown;
  containerSet?: unknown;
  resource?: unknown;
  http?: unknown;
  data?: unknown;
  plugin?: unknown;
  suspend?: unknown;
  dag?: { tasks?: SpecTask[]; target?: string; failFast?: boolean };
  steps?: SpecStep[][];
  [key: string]: unknown;
}

export interface TemplateRefLike {
  name?: string;
  template?: string;
  clusterScope?: boolean;
}

export interface SpecTask {
  name: string;
  template?: string;
  templateRef?: TemplateRefLike;
  inline?: SpecTemplate;
  depends?: string;
  dependencies?: string[];
  when?: string;
  withItems?: unknown[];
  withParam?: string;
  withSequence?: unknown;
  [key: string]: unknown;
}

export type SpecStep = SpecTask;

export interface SpecLike {
  entrypoint?: string;
  onExit?: string;
  templates?: SpecTemplate[];
  [key: string]: unknown;
}

export interface SpecNode {
  /** The task name, unique within its template. */
  id: string;
  task: SpecTask;
  kind: NodeKind;
  /** The template this task runs, when it is defined in the same spec. */
  template?: SpecTemplate;
  /** Set for steps: which group (0-based) the step belongs to. */
  group?: number;
  exit?: boolean;
}

export interface SpecEdge {
  id: string;
  source: string;
  target: string;
  /** The status condition of a `depends` term, e.g. "Failed" for `a.Failed`. */
  condition?: string;
}

export function templateKind(t?: SpecTemplate): NodeKind {
  if (!t) return "unknown";
  if (t.script) return "script";
  if (t.container) return "container";
  if (t.containerSet) return "containerSet";
  if (t.resource) return "resource";
  if (t.http) return "http";
  if (t.data) return "data";
  if (t.plugin) return "plugin";
  if (t.suspend !== undefined) return "suspend";
  if (t.dag) return "dag";
  if (t.steps) return "steps";
  return "unknown";
}

export function findTemplate(spec: SpecLike, name?: string): SpecTemplate | undefined {
  if (!name) return undefined;
  return spec.templates?.find((t) => t.name === name);
}

export function taskKind(spec: SpecLike, task: SpecTask): NodeKind {
  if (task.templateRef) return "ref";
  if (task.inline) return templateKind(task.inline);
  return templateKind(findTemplate(spec, task.template));
}

/**
 * The tasks a `depends` expression mentions, with the condition each is tested for. Argo's grammar is
 * task names, optional `.Condition` suffixes (Succeeded, Failed, Errored, Skipped, Omitted, Daemoned,
 * AnySucceeded, AllFailed), `&&`, `||`, `!` and parentheses.
 */
export function parseDepends(expression?: string): { task: string; condition?: string }[] {
  if (!expression) return [];
  const out: { task: string; condition?: string }[] = [];
  const re = /([A-Za-z0-9][A-Za-z0-9_-]*)(?:\.([A-Za-z]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expression))) {
    if (!out.some((d) => d.task === m![1] && d.condition === m![2])) out.push({ task: m[1], condition: m[2] });
  }
  return out;
}

/** Projects a DAG or steps template onto nodes and edges. */
export function templateGraph(spec: SpecLike, templateName?: string): { nodes: SpecNode[]; edges: SpecEdge[]; kind: "dag" | "steps" | "none" } {
  const template = findTemplate(spec, templateName ?? spec.entrypoint);
  if (!template) return { nodes: [], edges: [], kind: "none" };
  if (template.dag) {
    const tasks = template.dag.tasks ?? [];
    const names = new Set(tasks.map((t) => t.name));
    const nodes = tasks.map((task) => ({ id: task.name, task, kind: taskKind(spec, task), template: task.inline ?? findTemplate(spec, task.template) }));
    const edges: SpecEdge[] = [];
    for (const task of tasks) {
      const deps = task.depends ? parseDepends(task.depends) : (task.dependencies ?? []).map((d) => ({ task: d, condition: undefined }));
      for (const dep of deps) {
        if (!names.has(dep.task)) continue;
        const id = `${dep.task}->${task.name}${dep.condition ? `.${dep.condition}` : ""}`;
        if (!edges.some((e) => e.id === id)) edges.push({ id, source: dep.task, target: task.name, condition: dep.condition });
      }
    }
    return { nodes, edges, kind: "dag" };
  }
  if (template.steps) {
    const nodes: SpecNode[] = [];
    const edges: SpecEdge[] = [];
    template.steps.forEach((group, g) => {
      for (const step of group) nodes.push({ id: step.name, task: step, kind: taskKind(spec, step), template: step.inline ?? findTemplate(spec, step.template), group: g });
      if (g > 0) {
        for (const prev of template.steps![g - 1]) for (const step of group) edges.push({ id: `${prev.name}->${step.name}`, source: prev.name, target: step.name });
      }
    });
    return { nodes, edges, kind: "steps" };
  }
  return { nodes: [], edges: [], kind: "none" };
}

/** The exit handler named by spec.onExit, shown in its own lane. */
export function exitNode(spec: SpecLike): SpecNode | undefined {
  if (!spec.onExit) return undefined;
  const template = findTemplate(spec, spec.onExit);
  return { id: spec.onExit, task: { name: spec.onExit, template: spec.onExit }, kind: templateKind(template), template, exit: true };
}
