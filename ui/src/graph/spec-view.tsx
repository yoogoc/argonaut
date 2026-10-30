import "@xyflow/react/dist/style.css";

import { Background, Controls, type Edge, Handle, type Node, type NodeProps, Position, ReactFlow, useReactFlow } from "@xyflow/react";
import { Minus, Plus } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { phaseTone, toneSolid } from "@/components/common/phase-badge";
import { cn } from "@/lib/utils";
import { useTheme } from "@/stores/theme";
import { AutoFit } from "@/workflow/run-graph";

import { KindIcon, KINDS } from "./kinds";
import { layoutGraph } from "./layout";
import { type NestedEdge, nestedGraph, type NestedNode, openUnless } from "./nested";
import { type SpecLike, type SpecNode, standaloneTemplates, templateGraph } from "./spec";
import { canvasNavigation } from "./viewport";

type Data = {
  node: SpecNode;
  /** The task path, "region-eu/fetch"; the node id. */
  id?: string;
  phase?: string;
  count?: number;
  sub?: string;
  horizontal?: boolean;
  badge?: { label: string; tone: "mine" | "theirs" | "conflict" };
  /** For a DAG / steps task: how many tasks it has, and how to open it in place. */
  childCount?: number;
  onToggle?: (id: string) => void;
};

const badgeCard = { mine: "border-2 border-diff-mine bg-diff-mine-bg", theirs: "border-2 border-diff-theirs bg-diff-theirs-bg", conflict: "border-2 border-diff-conflict bg-diff-conflict-bg" };
const badgeTag = { mine: "bg-diff-mine", theirs: "bg-diff-theirs", conflict: "bg-diff-conflict" };

const SpecCard = memo(function SpecCard({ data }: NodeProps) {
  const { t } = useTranslation();
  const d = data as Data;
  const ref = d.node.task.templateRef;
  return (
    <div className={cn("relative flex h-full w-full items-center gap-2.5 rounded-xl border bg-card px-3", d.phase === "" && "border-dashed opacity-75", d.badge && badgeCard[d.badge.tone])}>
      {d.badge && <span className={cn("absolute -top-2.5 right-2 rounded-full px-1.5 text-[10px] font-bold text-white", badgeTag[d.badge.tone])}>{d.badge.label}</span>}
      {!d.badge && d.node.entry && <span className="absolute -top-2.5 right-2 rounded-full border bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">{t("Entrypoint")}</span>}
      <Handle type="target" position={d.horizontal ? Position.Left : Position.Top} className="!size-1.5 !border-0 !bg-muted-foreground/50" />
      <KindIcon kind={d.node.kind} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-xs font-semibold">{d.node.id}</span>
        <span className="truncate text-[11px] text-muted-foreground">
          {d.sub ?? (ref ? `${ref.name}${ref.clusterScope ? ` · ${t("cluster")}` : ""}` : t(KINDS[d.node.kind].label))}
          {d.childCount ? ` · ${t("{{count}} tasks", { count: d.childCount })}` : ""}
          {d.count && d.count > 1 ? ` · ×${d.count}` : ""}
        </span>
      </span>
      {d.childCount && d.onToggle ? <ToggleButton label={t("Expand {{name}}", { name: d.node.id })} onClick={() => d.onToggle!(d.id ?? d.node.id)} className="ml-auto" /> : null}
      {d.phase && <span aria-label={t(d.phase)} className={cn("absolute -top-1.5 -right-1.5 size-3.5 rounded-full border-2 border-card", toneSolid[phaseTone(d.phase)])} />}
      <Handle type="source" position={d.horizontal ? Position.Right : Position.Bottom} className="!size-1.5 !border-0 !bg-muted-foreground/50" />
    </div>
  );
});

/** "+" / "−" on a DAG task or group: opens or closes it in place. */
export function ToggleButton({ label, onClick, open, className }: { label: string; onClick: () => void; open?: boolean; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={!!open}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn("nodrag nopan flex size-5 shrink-0 items-center justify-center rounded-md border border-node-dag/40 text-node-dag hover:bg-node-dag-bg", className)}
    >
      {open ? <Minus className="size-3" aria-hidden /> : <Plus className="size-3" aria-hidden />}
    </button>
  );
}

/** An expanded DAG / steps task: a frame around the tasks of the template it runs. */
const SpecGroup = memo(function SpecGroup({ data }: NodeProps) {
  const { t } = useTranslation();
  const d = data as Data;
  return (
    <div className="relative h-full w-full rounded-xl border border-dashed border-node-dag/50 bg-node-dag-bg/25">
      <div className="absolute top-0 left-0 flex h-7 max-w-[calc(100%-2.5rem)] items-center gap-1.5 rounded-tl-xl rounded-br-lg bg-node-dag-bg px-2.5 text-[11px]">
        <span className="truncate font-mono font-semibold">{d.node.id}</span>
        <span className="shrink-0 text-muted-foreground">· {t(KINDS[d.node.kind].label)}</span>
      </div>
      {d.phase && <span aria-label={t(d.phase)} className={cn("absolute top-1.5 right-8 size-3.5 rounded-full border-2 border-card", toneSolid[phaseTone(d.phase)])} />}
      <ToggleButton label={t("Collapse {{name}}", { name: d.node.id })} open onClick={() => d.onToggle?.(d.id ?? d.node.id)} className="absolute top-1 right-1.5 bg-card" />
    </div>
  );
});

const nodeTypes = { spec: SpecCard, specGroup: SpecGroup };

/**
 * Fits the view again after a group opens or closes. AutoFit covers the first layout and resizes, but
 * it waits on React Flow's "nodes initialized" signal, which group frames (they have no handles) do
 * not reliably send; the new positions are known here, so this fits once they are rendered.
 */
function RefitOnLayout({ signature }: { signature: string }) {
  const { fitView } = useReactFlow();
  const first = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!signature) return;
    if (first.current === undefined) {
      first.current = signature;
      return;
    }
    const id = window.setTimeout(() => void fitView({ duration: 250, maxZoom: 0.9, padding: 0.2 }), 60);
    return () => window.clearTimeout(id);
  }, [signature, fitView]);
  return null;
}

/**
 * The graph to draw for a template. A DAG or steps template is drawn as its tasks; one whose entry is a
 * single step — a component, usually — as its templates, one node each (standaloneTemplates), so a
 * library of step variants shows every variant rather than only the entry.
 */
function entryGraph(spec: SpecLike, name?: string): ReturnType<typeof templateGraph> | { nodes: SpecNode[]; edges: []; kind: "single" } {
  const graph = templateGraph(spec, name);
  if (graph.kind !== "none") return graph;
  const nodes = standaloneTemplates(spec, name);
  return nodes.length ? { nodes, edges: [], kind: "single" } : graph;
}

/**
 * A read-only DAG of a template's entry (or any named) template. The run detail's design view passes
 * `status` to colour each task by how a run went; the template page shows it plain.
 */
export function SpecGraphView({
  spec,
  template,
  status,
  onSelect,
  badge,
  direction = "DOWN",
}: {
  badge?: (taskName: string) => { label: string; tone: "mine" | "theirs" | "conflict" } | undefined;
  spec: SpecLike;
  template?: string;
  /** `path` is the task's place among expanded groups, outermost first, ending with the task. */
  status?: (taskName: string, path: string[]) => { phase?: string; count?: number } | undefined;
  onSelect?: (taskName: string, path: string[]) => void;
  direction?: "DOWN" | "RIGHT";
}) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.resolved);
  const entry = template ?? spec.entrypoint;
  const graph = useMemo(() => entryGraph(spec, entry), [spec, entry]);
  // DAG and steps tasks are shown open in place (graph/nested.ts); the viewer closes what they don't need.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((id: string) => setClosed((prev) => (prev.has(id) ? new Set([...prev].filter((x) => x !== id)) : new Set([...prev, id]))), []);
  const nested = useMemo(() => (graph.kind === "single" ? undefined : nestedGraph(spec, entry, openUnless(closed))), [graph.kind, spec, entry, closed]);
  const items: NestedNode[] = nested ? nested.nodes : graph.nodes.map((n) => ({ id: n.id, path: [n.id], node: n, in: entry ?? "", group: false }));
  const drawn: NestedEdge[] = nested ? nested.edges : graph.edges;
  const shape = items.map((n) => `${n.id}:${n.group ? "g" : ""}`).join("|") + "#" + drawn.map((e) => e.id).join("|");
  const [positions, setPositions] = useState<Map<string, { x: number; y: number; width: number; height: number }>>();
  useEffect(() => {
    let cancelled = false;
    // Standalone templates have no edges to lay out by; they go in rows, in spec order, entry first.
    if (graph.kind === "single") {
      setPositions(new Map(items.map((n, i) => [n.id, { x: (i % 3) * 240, y: Math.floor(i / 3) * 92, width: 200, height: 52 }])));
      return;
    }
    void layoutGraph(
      items.map((n) => ({ id: n.id, width: 200, height: 52, parent: n.parent })),
      nested?.layoutEdges ?? [],
      direction,
    ).then((p) => !cancelled && setPositions(p));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, direction]);

  if (graph.kind === "none") return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{t("The entry template is not defined in this template.")}</div>;

  const nodes: Node[] = items
    .filter((n) => positions?.has(n.id) && (!n.parent || positions.has(n.parent)))
    .map((n) => {
      const p = positions!.get(n.id)!;
      const parent = n.parent ? positions!.get(n.parent) : undefined;
      const st = status?.(n.node.id, n.path);
      const width = n.group ? p.width : 200;
      const height = n.group ? p.height : 52;
      return {
        id: n.id,
        type: n.group ? "specGroup" : "spec",
        parentId: n.parent,
        position: parent ? { x: p.x - parent.x, y: p.y - parent.y } : { x: p.x, y: p.y },
        width,
        height,
        style: { width, height },
        zIndex: n.group ? 0 : 1,
        selectable: !n.group,
        data: {
          node: n.node,
          id: n.id,
          phase: status ? (st?.phase ?? "") : undefined,
          count: st?.count,
          horizontal: direction === "RIGHT",
          badge: n.path.length === 1 ? badge?.(n.node.id) : undefined,
          childCount: n.childCount,
          onToggle: n.childCount ? toggle : undefined,
        } satisfies Data,
      };
    });
  const edges: Edge[] = drawn.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.condition,
    zIndex: 1,
    labelBgPadding: [4, 2],
    labelStyle: { fontSize: 11, fontWeight: 600 },
    style: {
      stroke: e.condition === "Failed" || e.condition === "Errored" ? "var(--phase-fail-solid)" : "var(--muted-foreground)",
      strokeOpacity: 0.55,
      strokeDasharray: e.condition && e.condition !== "Succeeded" ? "5 4" : undefined,
    },
  }));
  const byId = new Map(items.map((n) => [n.id, n]));
  // Re-fit once the new layout has arrived: ELK answers after the shape changes, not with it.
  const fitKey = positions ? [...positions].map(([id, p]) => `${id}@${Math.round(p.x)},${Math.round(p.y)}`).join("|") : "";
  return (
    <ReactFlow
      {...canvasNavigation}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode={theme}
      fitView
      // A one- or two-node graph would otherwise be blown up to fill the canvas.
      fitViewOptions={{ maxZoom: 0.9, padding: 0.2 }}
      // Expanded groups make a wide graph; the fit has to be able to zoom out far enough to show it.
      minZoom={0.15}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      onNodeClick={(_e, node) => {
        const n = byId.get(node.id);
        if (n && !n.group) onSelect?.(n.node.id, n.path);
      }}
    >
      <AutoFit signature={shape} />
      <RefitOnLayout signature={fitKey} />
      <Background gap={16} size={1} />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}
