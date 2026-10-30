import { type SpecEdge, type SpecLike, type SpecNode, templateGraph } from "./spec";

// A template's graph with chosen DAG / steps tasks expanded in place: an expanded task becomes a group
// holding the graph of the template it runs, recursively. Nodes are addressed by their task path,
// "region-eu/publish/upload", since the same task name can appear inside several groups.
//
// Edges come in two sets. Drawn edges join the tasks that actually wait on each other: an edge into
// an expanded group lands on the group's first tasks (those with nothing upstream inside it), and an
// edge out of one leaves from its last. Layout edges stay between siblings — the group itself stands
// for its contents — so ELK lays each level out on its own and sizes groups around their children.

export interface NestedNode {
  /** The task path joined with "/". */
  id: string;
  path: string[];
  node: SpecNode;
  /** The group this node sits in. */
  parent?: string;
  /** The template this task belongs to: the entry for the top level, else the one its group runs. */
  in: string;
  /** Expanded: drawn as a frame around its children. */
  group: boolean;
  /** For a DAG / steps task: how many tasks the template it runs has. */
  childCount?: number;
}

export interface NestedEdge {
  id: string;
  source: string;
  target: string;
  condition?: string;
}

export interface NestedGraph {
  nodes: NestedNode[];
  edges: NestedEdge[];
  layoutEdges: NestedEdge[];
}

/** The template a task runs when it can be opened in place: a DAG or steps template of this spec. */
export function subTemplate(node: SpecNode): string | undefined {
  return (node.kind === "dag" || node.kind === "steps") && !node.task.templateRef && !node.task.inline ? node.task.template : undefined;
}

/** `open` says whether the DAG / steps task at a path is shown expanded. */
export function nestedGraph(spec: SpecLike, template: string | undefined, open: (id: string) => boolean): NestedGraph {
  const out: NestedGraph = { nodes: [], edges: [], layoutEdges: [] };
  build(spec, template, [], undefined, open, template ? [template] : [], out);
  return out;
}

/** Groups start open: what a viewer has closed is the exception. */
export const openUnless = (closed: ReadonlySet<string>) => (id: string) => !closed.has(id);

function build(spec: SpecLike, template: string | undefined, prefix: string[], parent: string | undefined, isOpen: (id: string) => boolean, stack: string[], out: NestedGraph): { entries: string[]; exits: string[] } {
  const graph = templateGraph(spec, template);
  const idOf = (task: string) => [...prefix, task].join("/");
  const ends = new Map<string, { entries: string[]; exits: string[] }>();

  for (const n of graph.nodes) {
    const path = [...prefix, n.id];
    const id = path.join("/");
    const sub = subTemplate(n);
    const childCount = sub ? templateGraph(spec, sub).nodes.length : undefined;
    // A template that contains itself further up is not opened again.
    const open = !!sub && !!childCount && isOpen(id) && !stack.includes(sub);
    out.nodes.push({ id, path, node: n, parent, in: template ?? "", group: open, childCount });
    if (open) ends.set(id, build(spec, sub, path, id, isOpen, [...stack, sub], out));
  }

  const entriesOf = (id: string) => ends.get(id)?.entries ?? [id];
  const exitsOf = (id: string) => ends.get(id)?.exits ?? [id];
  for (const e of graph.edges) {
    const s = idOf(e.source);
    const t = idOf(e.target);
    const suffix = e.condition ? `.${e.condition}` : "";
    out.layoutEdges.push({ id: `${s}->${t}${suffix}`, source: s, target: t, condition: e.condition });
    for (const a of exitsOf(s)) for (const b of entriesOf(t)) out.edges.push({ id: `${a}->${b}${suffix}`, source: a, target: b, condition: e.condition });
  }

  const hasIn = new Set(graph.edges.map((e: SpecEdge) => e.target));
  const hasOut = new Set(graph.edges.map((e: SpecEdge) => e.source));
  return {
    entries: graph.nodes.filter((n) => !hasIn.has(n.id)).flatMap((n) => entriesOf(idOf(n.id))),
    exits: graph.nodes.filter((n) => !hasOut.has(n.id)).flatMap((n) => exitsOf(idOf(n.id))),
  };
}
