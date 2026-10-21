import "@xyflow/react/dist/style.css";

import { Background, Controls, type Edge, Handle, type Node, type NodeProps, Position, ReactFlow } from "@xyflow/react";
import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { phaseTone, toneSolid } from "@/components/common/phase-badge";
import { cn } from "@/lib/utils";
import { useTheme } from "@/stores/theme";
import { AutoFit } from "@/workflow/run-graph";

import { KindIcon, KINDS } from "./kinds";
import { layoutGraph } from "./layout";
import { type SpecLike, type SpecNode, templateGraph } from "./spec";

type Data = { node: SpecNode; phase?: string; count?: number; sub?: string; horizontal?: boolean; badge?: { label: string; tone: "mine" | "theirs" | "conflict" } };

const badgeCard = { mine: "border-2 border-diff-mine bg-diff-mine-bg", theirs: "border-2 border-diff-theirs bg-diff-theirs-bg", conflict: "border-2 border-diff-conflict bg-diff-conflict-bg" };
const badgeTag = { mine: "bg-diff-mine", theirs: "bg-diff-theirs", conflict: "bg-diff-conflict" };

const SpecCard = memo(function SpecCard({ data }: NodeProps) {
  const { t } = useTranslation();
  const d = data as Data;
  const ref = d.node.task.templateRef;
  return (
    <div className={cn("relative flex h-full w-full items-center gap-2.5 rounded-xl border bg-card px-3", d.phase === "" && "border-dashed opacity-75", d.badge && badgeCard[d.badge.tone])}>
      {d.badge && <span className={cn("absolute -top-2.5 right-2 rounded-full px-1.5 text-[10px] font-bold text-white", badgeTag[d.badge.tone])}>{d.badge.label}</span>}
      <Handle type="target" position={d.horizontal ? Position.Left : Position.Top} className="!size-1.5 !border-0 !bg-muted-foreground/50" />
      <KindIcon kind={d.node.kind} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-xs font-semibold">{d.node.id}</span>
        <span className="truncate text-[11px] text-muted-foreground">
          {d.sub ?? (ref ? `${ref.name}${ref.clusterScope ? ` · ${t("cluster")}` : ""}` : t(KINDS[d.node.kind].label))}
          {d.count && d.count > 1 ? ` · ×${d.count}` : ""}
        </span>
      </span>
      {d.phase && <span aria-label={t(d.phase)} className={cn("absolute -top-1.5 -right-1.5 size-3.5 rounded-full border-2 border-card", toneSolid[phaseTone(d.phase)])} />}
      <Handle type="source" position={d.horizontal ? Position.Right : Position.Bottom} className="!size-1.5 !border-0 !bg-muted-foreground/50" />
    </div>
  );
});

const nodeTypes = { spec: SpecCard };

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
  status?: (taskName: string) => { phase?: string; count?: number } | undefined;
  onSelect?: (taskName: string) => void;
  direction?: "DOWN" | "RIGHT";
}) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.resolved);
  const graph = useMemo(() => templateGraph(spec, template ?? spec.entrypoint), [spec, template]);
  const shape = graph.nodes.map((n) => n.id).join("|") + "#" + graph.edges.map((e) => e.id).join("|");
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>();
  useEffect(() => {
    let cancelled = false;
    void layoutGraph(graph.nodes.map((n) => ({ id: n.id, width: 200, height: 52 })), graph.edges, direction).then((p) => !cancelled && setPositions(p));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, direction]);

  if (graph.kind === "none") return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{t("The entry template is not a DAG or steps template.")}</div>;

  const nodes: Node[] = graph.nodes
    .filter((n) => positions?.has(n.id))
    .map((n) => {
      const st = status?.(n.id);
      return { id: n.id, type: "spec", position: positions!.get(n.id)!, style: { width: 200, height: 52 }, data: { node: n, phase: status ? (st?.phase ?? "") : undefined, count: st?.count, horizontal: direction === "RIGHT", badge: badge?.(n.id) } satisfies Data };
    });
  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.condition,
    labelBgPadding: [4, 2],
    labelStyle: { fontSize: 11, fontWeight: 600 },
    style: { stroke: e.condition === "Failed" || e.condition === "Errored" ? "var(--phase-fail-solid)" : "var(--muted-foreground)", strokeOpacity: 0.55, strokeDasharray: e.condition && e.condition !== "Succeeded" ? "5 4" : undefined },
  }));
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode={theme}
      fitView
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      onNodeClick={(_e, node) => onSelect?.(node.id)}
    >
      <AutoFit signature={shape} />
      <Background gap={16} size={1} />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}
