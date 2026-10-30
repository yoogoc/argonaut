import type { Artifact, NodeStatus, Workflow } from "@/api/types";
import { resolveTemplate } from "@/lib/template";
import { artifactKey, isLogArtifact } from "@/lib/workflow";

export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 48;
export const ATTEMPT_WIDTH = 166;
export const ATTEMPT_HEIGHT = 40;
export const ARTIFACT_WIDTH = 150;
export const ARTIFACT_HEIGHT = 30;
export const HOOK_WIDTH = 116;
/** A hook pill wide enough for its event name (status dot, icon and duration around it). */
export const hookWidth = (event: string, planned = false) => Math.min(260, Math.max(HOOK_WIDTH, (planned ? 104 : 76) + event.length * 6.6));
export const HOOK_HEIGHT = 24;
/** Space between a step and the hook pills beside it, and between stacked pills. */
export const HOOK_GAP = 14;
export const HOOK_STACK_GAP = 6;

/** Identifies one artifact on one node, which is what the detail panel is opened for. */
export type ArtifactRef = { nodeId: string; name: string; isInput: boolean };

export interface RetryInfo {
  /** Attempts in start order. */
  attempts: NodeStatus[];
  /** Retries so far (attempts minus one). */
  retries: number;
  /** The configured retry limit, when the template declares one. */
  limit?: number;
}

/** A DAG or steps node that can be drawn open (a frame) or closed (a card). */
export interface DagInfo {
  /** How many nodes it ran directly (in its boundary). */
  count: number;
  open: boolean;
}

export type RuntimeNodeData =
  | { kind: "step"; status: NodeStatus; retry?: RetryInfo; expanded?: boolean; dag?: DagInfo; exit?: boolean }
  /** A DAG or steps node of the run, open: a frame around the nodes it ran. */
  | { kind: "dag"; status: NodeStatus; label: string; dag: DagInfo; exit?: boolean }
  | { kind: "attempt"; status: NodeStatus; index: number }
  | { kind: "group"; status: NodeStatus; label: string }
  /** `planned`: declared on the task or workflow but not run (its condition never held, or not yet). */
  | { kind: "hook"; status: NodeStatus; event: string; owner: string; planned?: boolean }
  | { kind: "artifact"; ref: ArtifactRef; artifact: Artifact };

export interface RuntimeNode {
  id: string;
  parent?: string;
  width: number;
  height: number;
  data: RuntimeNodeData;
}

export interface RuntimeEdge {
  id: string;
  source: string;
  target: string;
  /** Edge between retry attempts: the backoff the controller waited, when known. */
  backoff?: string;
  dashed?: boolean;
  failed?: boolean;
  animated?: boolean;
  /** The connector from a step to one of its hooks. */
  hook?: boolean;
  /** From the end of the flow to the workflow's exit handler, which runs once the rest is done. */
  exit?: boolean;
}

const ARTIFACT_PREFIX = "artifact::";

export function artifactNodeId(ref: ArtifactRef): string {
  return `${ARTIFACT_PREFIX}${ref.isInput ? "in" : "out"}::${ref.nodeId}::${ref.name}`;
}

const byStart = (a: NodeStatus, b: NodeStatus) => {
  const at = a.startedAt ? Date.parse(a.startedAt) : Number.MAX_SAFE_INTEGER;
  const bt = b.startedAt ? Date.parse(b.startedAt) : Number.MAX_SAFE_INTEGER;
  return at === bt ? a.name.localeCompare(b.name) : at - bt;
};

/**
 * Builds the run graph from Argo's node status.
 *
 * Argo records structure with virtual nodes (StepGroup, TaskGroup) that exist only to organise the run;
 * those are hidden and edges are rewired through them. A Retry node and its attempt pods are drawn one
 * of two ways (DESIGN, "重试节点"):
 *  - collapsed (default): one card per Retry node, with a dot per attempt and a retry count, and the
 *    attempt pods hidden — so a step that retried looks like one step, not a fan of pods;
 *  - expanded: the Retry node becomes a group with its attempts chained inside it in start order,
 *    each edge labelled with the backoff the controller waited before the next attempt.
 *
 * A DAG or steps node below the workflow's own is drawn as a frame around the nodes it ran — the ones
 * whose boundaryID is it — open by default; one listed in `closedDags` is a card instead, with its
 * contents hidden. Edges are kept at the level they belong to: an edge from inside a frame to outside
 * it leaves from the frame, and the frame's own links to its first nodes are containment, not edges.
 *
 * The workflow's exit handler, when it is a DAG or steps template (a single pod is a hook pill), runs
 * after everything else but Argo links it to nothing; it is drawn after the flow, joined by dashed
 * `exit` edges from the nodes the flow ends with.
 */
export function buildRuntimeGraph(
  wf: Workflow | undefined,
  options: { expandRetries: boolean; showArtifacts: boolean; retryLimit?: (node: NodeStatus) => number | undefined; closedDags?: ReadonlySet<string> },
): { nodes: RuntimeNode[]; edges: RuntimeEdge[] } {
  const statuses = wf?.status?.nodes;
  if (!wf || !statuses) return { nodes: [], edges: [] };

  const hidden = new Set<string>();
  for (const node of Object.values(statuses)) {
    if (node.type === "StepGroup" || node.type === "TaskGroup") hidden.add(node.id);
  }

  const retryInfo = new Map<string, RetryInfo>();
  const attemptOf = new Map<string, string>();
  for (const node of Object.values(statuses)) {
    if (node.type !== "Retry") continue;
    const attempts = (node.children ?? [])
      .map((id) => statuses[id])
      .filter((n): n is NodeStatus => !!n)
      .sort(byStart);
    attempts.forEach((a) => attemptOf.set(a.id, node.id));
    retryInfo.set(node.id, { attempts, retries: Math.max(0, attempts.length - 1), limit: options.retryLimit?.(node) });
    if (!options.expandRetries) attempts.forEach((a) => hidden.add(a.id));
  }

  // Lifecycle hooks and exit handlers run beside a step, not after it: they are drawn as small pills
  // attached to their owner rather than as steps in the flow.
  const hooks = findHooks(wf.metadata.name, statuses);

  // What a hook that runs a DAG or steps template ran stays inside its pill.
  const inHook = (id: string): boolean => {
    for (let b = statuses[id]?.boundaryID, i = 0; b && i < 50; b = statuses[b]?.boundaryID, i++) if (hooks.has(b)) return true;
    return false;
  };
  const hookInternals = new Set(Object.values(statuses).filter((n) => !hooks.has(n.id) && inHook(n.id)).map((n) => n.id));
  for (const id of hookInternals) hidden.add(id);

  // Nested DAG / steps nodes and what each ran (its boundary).
  const members = new Map<string, number>();
  for (const n of Object.values(statuses)) if (n.boundaryID) members.set(n.boundaryID, (members.get(n.boundaryID) ?? 0) + 1);
  const dags = new Set(Object.values(statuses).filter((n) => (n.type === "DAG" || n.type === "Steps") && n.id !== wf.metadata.name && !hooks.has(n.id) && !hidden.has(n.id) && members.get(n.id)).map((n) => n.id));
  const closed = options.closedDags ?? new Set<string>();
  /** The frames a node sits in, innermost first. */
  const framesOf = (id: string): string[] => {
    const out: string[] = [];
    for (let b = statuses[id]?.boundaryID; b && dags.has(b) && !out.includes(b); b = statuses[b]?.boundaryID) out.push(b);
    return out;
  };
  /** What stands for a node: itself, or the outermost closed frame hiding it. */
  const shownAs = (id: string): string => {
    const frames = framesOf(id);
    for (let i = frames.length - 1; i >= 0; i--) if (closed.has(frames[i])) return frames[i];
    return id;
  };
  for (const n of Object.values(statuses)) if (shownAs(n.id) !== n.id) hidden.add(n.id);
  const dagInfo = (id: string): DagInfo => ({ count: members.get(id) ?? 0, open: !closed.has(id) });
  const exitHandler = Object.values(statuses).find((n) => n.name === `${wf.metadata.name}.onExit` && !hooks.has(n.id))?.id;

  const nodes: RuntimeNode[] = [];
  const edges: RuntimeEdge[] = [];
  const visible = Object.values(statuses).filter((n) => !hidden.has(n.id));

  for (const node of visible) {
    const hook = hooks.get(node.id);
    if (hook) {
      nodes.push({ id: node.id, width: hookWidth(hook.event), height: HOOK_HEIGHT, data: { kind: "hook", status: node, event: hook.event, owner: hook.owner } });
      continue;
    }
    const frame = framesOf(node.id)[0];
    if (dags.has(node.id) && !closed.has(node.id)) {
      nodes.push({ id: node.id, parent: frame, width: 0, height: 0, data: { kind: "dag", status: node, label: node.displayName || node.name, dag: dagInfo(node.id), exit: node.id === exitHandler } });
      continue;
    }
    const retry = retryInfo.get(node.id);
    if (retry && options.expandRetries && retry.attempts.length > 0) {
      nodes.push({ id: node.id, parent: frame, width: 0, height: 0, data: { kind: "group", status: node, label: node.displayName || node.name } });
      continue;
    }
    const parentRetry = attemptOf.get(node.id);
    if (parentRetry && options.expandRetries) {
      const index = retryInfo.get(parentRetry)!.attempts.findIndex((a) => a.id === node.id);
      nodes.push({ id: node.id, parent: parentRetry, width: ATTEMPT_WIDTH, height: ATTEMPT_HEIGHT, data: { kind: "attempt", status: node, index } });
      continue;
    }
    nodes.push({ id: node.id, parent: frame, width: NODE_WIDTH, height: NODE_HEIGHT, data: { kind: "step", status: node, retry, expanded: false, dag: dags.has(node.id) ? dagInfo(node.id) : undefined, exit: node.id === exitHandler } });
  }

  // Walk through hidden nodes to the visible descendants an edge should point at.
  const resolveTargets = (id: string, seen = new Set<string>()): string[] => {
    const node = statuses[id];
    if (!node || seen.has(id)) return [];
    if (!hidden.has(id)) return [id];
    if (hookInternals.has(id)) return [];
    if (shownAs(id) !== id) return [shownAs(id)];
    seen.add(id);
    return (node.children ?? []).flatMap((child) => resolveTargets(child, seen));
  };

  // The frames around any drawn node, artifacts included (they sit in their owner's frame).
  const framesAround = (id: string): string[] => {
    if (statuses[id]) return framesOf(id).filter((f) => !closed.has(f));
    const parent = nodes.find((n) => n.id === id)?.parent;
    return parent ? [parent, ...framesAround(parent)] : [];
  };
  /**
   * Moves an edge to the level where both ends are siblings: an end inside a frame the other end is
   * not in is replaced by that frame. An edge between a frame and its own contents is dropped — the
   * frame drawn around them says it.
   */
  const lift = (edge: RuntimeEdge): RuntimeEdge | undefined => {
    const source = statuses[edge.source] ? shownAs(edge.source) : edge.source;
    const target = statuses[edge.target] ? shownAs(edge.target) : edge.target;
    if (edge.hook) return hidden.has(source) || hidden.has(target) ? undefined : edge;
    const up = [source, ...framesAround(source)];
    const down = [target, ...framesAround(target)];
    if (up.includes(target) || down.includes(source)) return undefined;
    const common = up.find((f) => down.includes(f));
    const s = common ? up[up.indexOf(common) - 1] : up[up.length - 1];
    const t = common ? down[down.indexOf(common) - 1] : down[down.length - 1];
    return s === edge.source && t === edge.target ? edge : { ...edge, id: `${s}->${t}`, source: s, target: t };
  };

  const seenEdges = new Set<string>();
  const addEdge = (raw: RuntimeEdge) => {
    // A hook hangs off its owner by its own connector (below), never by a flow edge.
    if (hooks.has(raw.target) && !raw.hook) return;
    const edge = lift(raw);
    if (!edge || edge.source === edge.target || seenEdges.has(edge.id)) return;
    seenEdges.add(edge.id);
    edges.push(edge);
  };

  for (const node of visible) {
    if (hooks.has(node.id)) continue;
    const retry = retryInfo.get(node.id);
    if (retry) {
      if (options.expandRetries) {
        // Inside the group, attempts chain in order; the next attempt starts after the previous one
        // failed and the backoff elapsed.
        retry.attempts.forEach((attempt, i) => {
          const next = retry.attempts[i + 1];
          if (!next) return;
          addEdge({
            id: `${attempt.id}->${next.id}`,
            source: attempt.id,
            target: next.id,
            failed: true,
            dashed: true,
            backoff: backoffBetween(attempt, next),
          });
        });
        // The steps after this one depend on the Retry node as a whole.
        for (const attempt of retry.attempts) {
          for (const child of attempt.children ?? []) {
            for (const target of resolveTargets(child)) {
              if (attemptOf.get(target) === node.id) continue;
              addEdge({ id: `${node.id}->${target}`, source: node.id, target, animated: statuses[target]?.phase === "Running" });
            }
          }
        }
        continue;
      }
      // Collapsed: edges leave from the card, through its hidden attempts.
      for (const attempt of retry.attempts) {
        for (const child of attempt.children ?? []) {
          for (const target of resolveTargets(child)) {
            addEdge({ id: `${node.id}->${target}`, source: node.id, target, animated: statuses[target]?.phase === "Running" });
          }
        }
      }
      continue;
    }
    if (attemptOf.has(node.id)) continue;
    for (const child of node.children ?? []) {
      for (const target of resolveTargets(child)) {
        if (attemptOf.get(target) === node.id) continue;
        // An edge into an attempt means "into its Retry node".
        const into = attemptOf.get(target) && options.expandRetries ? attemptOf.get(target)! : target;
        addEdge({ id: `${node.id}->${into}`, source: node.id, target: into, animated: statuses[into]?.phase === "Running" });
      }
    }
  }

  // What a closed frame hides still leads somewhere: its last nodes' edges leave from the card.
  for (const node of Object.values(statuses)) {
    if (shownAs(node.id) === node.id || hooks.has(node.id)) continue;
    for (const child of node.children ?? []) {
      for (const target of resolveTargets(child)) addEdge({ id: `${node.id}->${target}`, source: node.id, target, animated: statuses[target]?.phase === "Running" });
    }
  }

  // The exit handler runs after the flow: join it from the top-level nodes nothing else follows.
  if (exitHandler && !hidden.has(exitHandler)) {
    const followed = new Set(edges.filter((e) => !e.hook && !e.dashed).map((e) => e.source));
    const ends = nodes.filter((n) => !n.parent && n.id !== exitHandler && (n.data.kind === "step" || n.data.kind === "dag" || n.data.kind === "group") && !followed.has(n.id));
    for (const end of ends) addEdge({ id: `${end.id}->${exitHandler}`, source: end.id, target: exitHandler, dashed: true, exit: true });
  }

  for (const [id, hook] of hooks) {
    // The owner may be an attempt drawn inside its Retry card when retries are collapsed.
    const owner = attemptOf.get(hook.owner) && !options.expandRetries ? attemptOf.get(hook.owner)! : hook.owner;
    if (!statuses[owner] || hidden.has(owner)) continue;
    hook.owner = owner;
    const node = nodes.find((n) => n.id === id);
    if (node && node.data.kind === "hook") node.data.owner = owner;
    addEdge({ id: `${owner}=>${id}`, source: owner, target: id, hook: true, dashed: true, animated: statuses[id]?.phase === "Running" });
  }

  // Hooks the template declares but the run has no node for: their condition never held, or the
  // owner has not finished yet. Drawn as hollow pills, so every hook is visible, fired or not.
  const fired = new Set([...hooks.values()].map((h) => `${h.owner}\u0000${h.event}`));
  const plan = (owner: string, events: string[]) => {
    for (const event of events) {
      if (fired.has(`${owner}\u0000${event}`)) continue;
      fired.add(`${owner}\u0000${event}`);
      const id = `planned-hook::${owner}::${event}`;
      const status = { id, name: `${statuses[owner]?.name ?? owner}.hooks.${event}`, displayName: event, type: "Pod" } as NodeStatus;
      nodes.push({ id, width: hookWidth(event, true), height: HOOK_HEIGHT, data: { kind: "hook", status, event, owner, planned: true } });
      addEdge({ id: `${owner}=>${id}`, source: owner, target: id, hook: true, dashed: true });
    }
  };
  for (const n of nodes) {
    if (n.data.kind !== "step" && n.data.kind !== "dag" && n.data.kind !== "group") continue;
    const status = n.data.status;
    const boundary = status.boundaryID ? statuses[status.boundaryID] : undefined;
    if (!boundary) continue;
    const owning = resolveTemplate(wf, boundary);
    const name = status.displayName.replace(/\(\d+\)$/, "");
    // The api types only carry what the UI used so far; a task's hooks and onExit are read as plain fields.
    const tasks = [...(owning?.dag?.tasks ?? []), ...(owning?.steps?.flat() ?? [])] as { name: string; hooks?: Record<string, unknown>; onExit?: string }[];
    const task = tasks.find((x) => x.name === name);
    const declared = Object.keys((task?.hooks ?? {}) as Record<string, unknown>);
    if (task?.onExit && !declared.includes("exit")) declared.push("exit");
    plan(n.id, declared);
  }
  const root = statuses[wf.metadata.name];
  const execSpec = (wf.status?.storedWorkflowTemplateSpec ?? wf.spec) as { hooks?: Record<string, unknown>; onExit?: string } | undefined;
  if (root && !hidden.has(root.id)) {
    const declared = Object.keys(execSpec?.hooks ?? {});
    if ((execSpec?.onExit || execSpec?.hooks?.exit) && !exitHandler) declared.push("exit");
    plan(root.id, [...new Set(declared.filter((e) => e !== "exit" || !exitHandler))]);
  }

  if (options.showArtifacts)
    addArtifacts(
      Object.values(statuses).filter((n) => (!hidden.has(n.id) || (attemptOf.has(n.id) && shownAs(n.id) === n.id)) && !hooks.has(n.id)),
      nodes,
      edges,
      addEdge,
      (id) => {
        const retry = attemptOf.get(id);
        return retry && !options.expandRetries ? retry : id;
      },
      (owner) => nodes.find((n) => n.id === owner)?.parent,
    );

  return { nodes, edges };
}

/** The pause between one attempt finishing and the next starting — the retry backoff in effect. */
function backoffBetween(previous: NodeStatus, next: NodeStatus): string | undefined {
  if (!previous.finishedAt || !next.startedAt) return undefined;
  const seconds = Math.round((Date.parse(next.startedAt) - Date.parse(previous.finishedAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 1) return undefined;
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

/**
 * Artifacts become their own nodes so the data a run moved is visible. An input that is the same
 * stored object as an upstream output (Argo records the same storage key on both sides) is drawn once,
 * producer → artifact → consumer.
 */
function addArtifacts(
  pods: NodeStatus[],
  nodes: RuntimeNode[],
  _edges: RuntimeEdge[],
  addEdge: (e: RuntimeEdge) => void,
  owner: (id: string) => string,
  /** The frame an artifact is drawn in: its owner's. */
  frameOf: (owner: string) => string | undefined,
) {
  const producedByKey = new Map<string, string>();
  const podNodes = pods.filter((n) => n.type === "Pod");
  for (const node of podNodes) {
    for (const artifact of node.outputs?.artifacts ?? []) {
      if (isLogArtifact(artifact)) continue;
      const ref = { nodeId: node.id, name: artifact.name, isInput: false };
      const id = artifactNodeId(ref);
      if (nodes.some((n) => n.id === id)) continue;
      nodes.push({ id, parent: frameOf(owner(node.id)), width: ARTIFACT_WIDTH, height: ARTIFACT_HEIGHT, data: { kind: "artifact", ref, artifact } });
      addEdge({ id: `${owner(node.id)}->${id}`, source: owner(node.id), target: id, dashed: true });
      const key = artifactKey(artifact);
      if (key && !producedByKey.has(key)) producedByKey.set(key, id);
    }
  }
  for (const node of podNodes) {
    for (const artifact of node.inputs?.artifacts ?? []) {
      if (isLogArtifact(artifact)) continue;
      const key = artifactKey(artifact);
      const producer = key ? producedByKey.get(key) : undefined;
      if (producer) {
        addEdge({ id: `${producer}->${owner(node.id)}`, source: producer, target: owner(node.id), dashed: true });
        continue;
      }
      const ref = { nodeId: node.id, name: artifact.name, isInput: true };
      const id = artifactNodeId(ref);
      if (nodes.some((n) => n.id === id)) continue;
      nodes.push({ id, parent: frameOf(owner(node.id)), width: ARTIFACT_WIDTH, height: ARTIFACT_HEIGHT, data: { kind: "artifact", ref, artifact } });
      addEdge({ id: `${id}->${owner(node.id)}`, source: id, target: owner(node.id), dashed: true });
    }
  }
}

const HOOK_SUFFIX = /\.hooks\.([^.]+)$/;

/**
 * Finds the nodes that are hooks rather than steps: lifecycle hooks ("<task>.hooks.<event>", children
 * of their task) and exit handlers ("<owner>.onExit": the workflow's, or a task's `exit` hook). Each is
 * drawn as a pill, whatever it runs; the one exception is a workflow exit handler that is a DAG or steps
 * template, drawn as a frame after the flow.
 */
export function findHooks(workflowName: string, statuses: Record<string, NodeStatus>): Map<string, { event: string; owner: string }> {
  const byName = new Map(Object.values(statuses).map((n) => [n.name, n.id]));
  const parentOf = new Map<string, string>();
  for (const n of Object.values(statuses)) for (const c of n.children ?? []) parentOf.set(c, n.id);
  const out = new Map<string, { event: string; owner: string }>();
  for (const n of Object.values(statuses)) {
    // A hook may run a DAG or steps template too; it is still one pill, its own nodes folded into it.
    // Only the workflow's exit handler is drawn otherwise when it is not a pod (a frame after the flow).
    if (n.type === "StepGroup" || n.type === "TaskGroup" || (n.type !== "Pod" && n.name === `${workflowName}.onExit`)) continue;
    const lifecycle = n.name.match(HOOK_SUFFIX);
    if (lifecycle) {
      const owner = parentOf.get(n.id) ?? byName.get(n.name.slice(0, -lifecycle[0].length));
      if (owner) out.set(n.id, { event: lifecycle[1], owner });
      continue;
    }
    if (n.name.endsWith(".onExit")) {
      const ownerName = n.name.slice(0, -".onExit".length);
      const owner = byName.get(ownerName) ?? (ownerName === workflowName ? byName.get(workflowName) : undefined);
      if (owner) out.set(n.id, { event: "exit", owner });
    }
  }
  return out;
}
