import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk-api.js";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";

// ELK runs in a Web Worker so laying out a large graph never blocks typing or scrolling (DESIGN §5.4).
const elk = new ELK({ workerFactory: () => new ElkWorker() });

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
  /** Lays this node out inside another (a retry group, an expanded fan-out). */
  parent?: string;
  /** For a group: the narrowest it may be, so a header wider than its contents still fits. */
  minWidth?: number;
}

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
}

export interface Positioned {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Direction = "DOWN" | "RIGHT";

/**
 * Computes positions for a layered graph. Children of a parent are laid out inside it, in the same
 * direction, and the parent is sized to fit them; positions are absolute.
 */
export async function layoutGraph(nodes: LayoutNode[], edges: LayoutEdge[], direction: Direction = "DOWN"): Promise<Map<string, Positioned>> {
  const byId = new Map<string, ElkNode>();
  const roots: ElkNode[] = [];
  for (const n of nodes) byId.set(n.id, { id: n.id, width: n.width, height: n.height, children: [] });
  for (const n of nodes) {
    const elkNode = byId.get(n.id)!;
    const parent = n.parent ? byId.get(n.parent) : undefined;
    if (parent) {
      parent.children!.push(elkNode);
      const min = nodes.find((x) => x.id === n.parent)?.minWidth;
      parent.layoutOptions = {
        // With a DOWN layout and hierarchy handling, ELK reads a group's minimum size with its axes
        // swapped (it lays out transposed), so the width goes second there.
        ...(min ? { "elk.nodeSize.constraints": "[MINIMUM_SIZE]", "elk.nodeSize.minimum": direction === "DOWN" ? `(0, ${min})` : `(${min}, 0)` } : {}),
        "elk.padding": "[top=34,left=12,bottom=12,right=12]",
        "elk.algorithm": "layered",
        "elk.direction": direction,
        "elk.spacing.nodeNode": "14",
        "elk.layered.spacing.nodeNodeBetweenLayers": "18",
      };
      // A group's size is computed from its children.
      delete parent.width;
      delete parent.height;
    } else roots.push(elkNode);
  }
  const elkEdges: ElkExtendedEdge[] = edges
    .filter((e) => byId.has(e.source) && byId.has(e.target))
    .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] }));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "44",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.crossingMinimization.semiInteractive": "true",
    },
    children: roots,
    edges: elkEdges,
  };
  const result = await elk.layout(graph);

  const out = new Map<string, Positioned>();
  const widened = new Set(nodes.filter((n) => n.minWidth).map((n) => n.id));
  const walk = (node: ElkNode, offsetX: number, offsetY: number) => {
    // A group made wider than its contents (minWidth) keeps them centred rather than at its left edge.
    const right = Math.max(0, ...(node.children ?? []).map((c) => (c.x ?? 0) + (c.width ?? 0)));
    const left = Math.min(...(node.children ?? []).map((c) => c.x ?? 0));
    const shift = widened.has(node.id) && node.children?.length ? Math.max(0, ((node.width ?? 0) - right - left) / 2) : 0;
    for (const child of node.children ?? []) {
      const x = offsetX + shift + (child.x ?? 0);
      const y = offsetY + (child.y ?? 0);
      out.set(child.id, { x, y, width: child.width ?? 0, height: child.height ?? 0 });
      walk(child, x, y);
    }
  };
  walk(result, 0, 0);
  return out;
}
