import type { Artifact, NodeStatus, Workflow } from "@/api/types";
import { artifactKey, isLogArtifact } from "@/lib/workflow";

export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 48;
export const ATTEMPT_WIDTH = 166;
export const ATTEMPT_HEIGHT = 40;
export const ARTIFACT_WIDTH = 150;
export const ARTIFACT_HEIGHT = 30;
export const HOOK_WIDTH = 116;
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

export type RuntimeNodeData =
  | { kind: "step"; status: NodeStatus; retry?: RetryInfo; expanded?: boolean }
  | { kind: "attempt"; status: NodeStatus; index: number }
  | { kind: "group"; status: NodeStatus; label: string }
  | { kind: "hook"; status: NodeStatus; event: string; owner: string }
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
 */
export function buildRuntimeGraph(
  wf: Workflow | undefined,
  options: { expandRetries: boolean; showArtifacts: boolean; retryLimit?: (node: NodeStatus) => number | undefined },
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

  const nodes: RuntimeNode[] = [];
  const edges: RuntimeEdge[] = [];
  const visible = Object.values(statuses).filter((n) => !hidden.has(n.id));

  for (const node of visible) {
    const hook = hooks.get(node.id);
    if (hook) {
      nodes.push({ id: node.id, width: HOOK_WIDTH, height: HOOK_HEIGHT, data: { kind: "hook", status: node, event: hook.event, owner: hook.owner } });
      continue;
    }
    const retry = retryInfo.get(node.id);
    if (retry && options.expandRetries && retry.attempts.length > 0) {
      nodes.push({ id: node.id, width: 0, height: 0, data: { kind: "group", status: node, label: node.displayName || node.name } });
      continue;
    }
    const parentRetry = attemptOf.get(node.id);
    if (parentRetry && options.expandRetries) {
      const index = retryInfo.get(parentRetry)!.attempts.findIndex((a) => a.id === node.id);
      nodes.push({ id: node.id, parent: parentRetry, width: ATTEMPT_WIDTH, height: ATTEMPT_HEIGHT, data: { kind: "attempt", status: node, index } });
      continue;
    }
    nodes.push({ id: node.id, width: NODE_WIDTH, height: NODE_HEIGHT, data: { kind: "step", status: node, retry, expanded: false } });
  }

  // Walk through hidden nodes to the visible descendants an edge should point at.
  const resolveTargets = (id: string, seen = new Set<string>()): string[] => {
    const node = statuses[id];
    if (!node || seen.has(id)) return [];
    if (!hidden.has(id)) return [id];
    seen.add(id);
    return (node.children ?? []).flatMap((child) => resolveTargets(child, seen));
  };

  const seenEdges = new Set<string>();
  const addEdge = (edge: RuntimeEdge) => {
    // A hook hangs off its owner by its own connector (below), never by a flow edge.
    if (hooks.has(edge.target) && !edge.hook) return;
    if (edge.source === edge.target || seenEdges.has(edge.id)) return;
    seenEdges.add(edge.id);
    edges.push(edge);
  };

  for (const node of visible) {
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

  for (const [id, hook] of hooks) {
    // The owner may be an attempt drawn inside its Retry card when retries are collapsed.
    const owner = attemptOf.get(hook.owner) && !options.expandRetries ? attemptOf.get(hook.owner)! : hook.owner;
    if (!statuses[owner] || hidden.has(owner)) continue;
    hook.owner = owner;
    const node = nodes.find((n) => n.id === id);
    if (node && node.data.kind === "hook") node.data.owner = owner;
    addEdge({ id: `${owner}=>${id}`, source: owner, target: id, hook: true, dashed: true, animated: statuses[id]?.phase === "Running" });
  }

  if (options.showArtifacts) addArtifacts(Object.values(statuses).filter((n) => (!hidden.has(n.id) || attemptOf.has(n.id)) && !hooks.has(n.id)), nodes, edges, addEdge, (id) => {
    const retry = attemptOf.get(id);
    return retry && !options.expandRetries ? retry : id;
  });

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
) {
  const producedByKey = new Map<string, string>();
  const podNodes = pods.filter((n) => n.type === "Pod");
  for (const node of podNodes) {
    for (const artifact of node.outputs?.artifacts ?? []) {
      if (isLogArtifact(artifact)) continue;
      const ref = { nodeId: node.id, name: artifact.name, isInput: false };
      const id = artifactNodeId(ref);
      if (nodes.some((n) => n.id === id)) continue;
      nodes.push({ id, width: ARTIFACT_WIDTH, height: ARTIFACT_HEIGHT, data: { kind: "artifact", ref, artifact } });
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
      nodes.push({ id, width: ARTIFACT_WIDTH, height: ARTIFACT_HEIGHT, data: { kind: "artifact", ref, artifact } });
      addEdge({ id: `${id}->${owner(node.id)}`, source: id, target: owner(node.id), dashed: true });
    }
  }
}

const HOOK_SUFFIX = /\.hooks\.([^.]+)$/;

/**
 * Finds the nodes that are hooks rather than steps: lifecycle hooks ("<task>.hooks.<event>", children
 * of their task) and exit handlers ("<owner>.onExit": the workflow's, or a task's `exit` hook). Only
 * pods are drawn as pills; an exit handler that is itself a DAG keeps its steps in the flow.
 */
export function findHooks(workflowName: string, statuses: Record<string, NodeStatus>): Map<string, { event: string; owner: string }> {
  const byName = new Map(Object.values(statuses).map((n) => [n.name, n.id]));
  const parentOf = new Map<string, string>();
  for (const n of Object.values(statuses)) for (const c of n.children ?? []) parentOf.set(c, n.id);
  const out = new Map<string, { event: string; owner: string }>();
  for (const n of Object.values(statuses)) {
    if (n.type !== "Pod") continue;
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
