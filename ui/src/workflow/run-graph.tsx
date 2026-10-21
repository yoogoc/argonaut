import "@xyflow/react/dist/style.css";

import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { ArrowDownToLine, ArrowUpFromLine, Database, RotateCcw } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { NodeStatus, Workflow } from "@/api/types";
import { phaseTone, toneSolid } from "@/components/common/phase-badge";
import { layoutGraph } from "@/graph/layout";
import { type ArtifactRef, buildRuntimeGraph, type RuntimeNodeData } from "@/graph/runtime";
import { useNow } from "@/hooks/use-now";
import { formatDuration } from "@/lib/format";
import { resolveTemplate } from "@/lib/template";
import { cn } from "@/lib/utils";
import { useTheme } from "@/stores/theme";

type FlowData = RuntimeNodeData & { selected: boolean; now: number };

function StatusDot({ phase, className }: { phase?: string; className?: string }) {
  const tone = phaseTone(phase);
  return <span aria-hidden className={cn("flex size-5 shrink-0 items-center justify-center rounded-full", toneSolid[tone], tone === "pend" && "bg-transparent ring-2 ring-phase-pend-solid ring-inset", className)} />;
}

/** One dot per retry attempt: hollow red for failed, solid for the rest. */
function AttemptDots({ attempts }: { attempts: NodeStatus[] }) {
  return (
    <span className="flex items-center gap-0.5" aria-hidden>
      {attempts.map((a) => {
        const tone = phaseTone(a.phase);
        return <span key={a.id} className={cn("size-2 rounded-full", tone === "fail" ? "border-2 border-phase-fail-solid bg-phase-fail-bg" : toneSolid[tone])} />;
      })}
    </span>
  );
}

const StepNode = memo(function StepNode({ data }: NodeProps) {
  const { t } = useTranslation();
  const d = data as FlowData & { kind: "step" };
  const s = d.status;
  const retry = d.retry;
  // A Retry card shows the latest attempt's state; its own phase lags behind while it backs off.
  const shown = retry?.attempts.at(-1) ?? s;
  const cached = s.memoizationStatus?.hit === true;
  const running = shown.phase === "Running";
  return (
    <div
      className={cn(
        "relative flex h-full w-full items-center gap-2 rounded-[10px] border bg-card px-2.5 text-left shadow-xs",
        d.selected && "border-2 border-primary ring-4 ring-primary/15",
        !d.selected && shown.phase === "Pending" && "border-dashed",
      )}
      title={`${s.displayName || s.name} — ${shown.phase ?? "Pending"}`}
    >
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-muted-foreground/50" />
      {retry && retry.retries > 0 && (
        <span className="absolute -top-2.5 right-2 flex h-[18px] items-center gap-1 rounded-full border border-phase-susp-solid/40 bg-phase-susp-bg px-1.5 text-[10px] font-semibold text-phase-susp">
          <RotateCcw className="size-2.5" aria-hidden />
          {retry.limit !== undefined ? t("Retried {{n}}/{{limit}}", { n: retry.retries, limit: retry.limit }) : t("Retried {{n}}", { n: retry.retries })}
        </span>
      )}
      {cached && <span className="absolute -top-2.5 right-2 rounded-full bg-node-script-bg px-1.5 text-[10px] font-semibold text-node-script">{t("cache hit")}</span>}
      <StatusDot phase={shown.phase} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-xs font-medium">{s.displayName || s.name}</span>
        <span className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
          {retry && retry.attempts.length > 1 && <AttemptDots attempts={retry.attempts} />}
          {retry && retry.attempts.length > 1
            ? t("Attempt {{n}}", { n: retry.attempts.length })
            : shown.phase === "Pending" || !shown.startedAt
              ? t(s.type)
              : `${running ? t("running") + " " : ""}${formatDuration(shown.startedAt, shown.finishedAt, d.now)}`}
        </span>
      </span>
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-muted-foreground/50" />
    </div>
  );
});

/** "main: Error (exit code 137)" → "exit 137"; OOMKilled and similar reasons are kept as they are. */
function exitSummary(message?: string): string | undefined {
  if (!message) return undefined;
  const code = message.match(/exit code (\d+)/);
  if (/OOMKilled/i.test(message)) return "OOMKilled";
  return code ? `exit ${code[1]}` : message.slice(0, 24);
}

const AttemptNode = memo(function AttemptNode({ data }: NodeProps) {
  const { t } = useTranslation();
  const d = data as FlowData & { kind: "attempt" };
  const s = d.status;
  const failed = phaseTone(s.phase) === "fail";
  return (
    <div className={cn("flex h-full w-full items-center gap-2 rounded-lg border bg-card px-2.5", failed && "border-phase-fail-solid/50", d.selected && "border-2 border-primary ring-4 ring-primary/15")}>
      <Handle type="target" position={Position.Top} className="!size-1 !border-0 !bg-transparent" />
      <StatusDot phase={s.phase} className="size-4" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-[11px] font-semibold">
          #{d.index + 1} {t(s.phase ?? "Pending")}
        </span>
        <span className="truncate text-[10px] text-muted-foreground">
          {failed && exitSummary(s.message) ? `${exitSummary(s.message)} · ` : ""}
          {formatDuration(s.startedAt, s.finishedAt, d.now)}
        </span>
      </span>
      <Handle type="source" position={Position.Bottom} className="!size-1 !border-0 !bg-transparent" />
    </div>
  );
});

const GroupNode = memo(function GroupNode({ data }: NodeProps) {
  const { t } = useTranslation();
  const d = data as FlowData & { kind: "group" };
  return (
    <div className="h-full w-full rounded-xl border border-dashed border-phase-susp-solid/60 bg-phase-susp-bg/30">
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-muted-foreground/50" />
      <div className="flex items-center gap-1.5 px-3 pt-2 text-xs">
        <RotateCcw className="size-3 text-phase-susp" aria-hidden />
        <span className="font-mono font-semibold">{d.label}</span>
        <span className="text-muted-foreground">Retry</span>
      </div>
      <span className="sr-only">{t("Retry group")}</span>
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-muted-foreground/50" />
    </div>
  );
});

const ArtifactNode = memo(function ArtifactNode({ data }: NodeProps) {
  const d = data as FlowData & { kind: "artifact" };
  const Icon = d.ref.isInput ? ArrowDownToLine : ArrowUpFromLine;
  return (
    <div
      className={cn(
        "flex h-full w-full cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-phase-susp-solid bg-phase-susp-bg/60 px-2 text-[11px] text-phase-susp",
        d.selected && "border-solid ring-4 ring-primary/15",
      )}
    >
      <Handle type="target" position={Position.Top} className="!size-1 !border-0 !bg-transparent" />
      <Database className="size-3 shrink-0" aria-hidden />
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate font-mono">{d.ref.name}</span>
      <Handle type="source" position={Position.Bottom} className="!size-1 !border-0 !bg-transparent" />
    </div>
  );
});

function RunEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, style }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const backoff = (data as { backoff?: string } | undefined)?.backoff;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {backoff && (
        <EdgeLabelRenderer>
          <span
            className="pointer-events-none absolute rounded bg-card px-1 text-[10px] font-semibold text-phase-fail"
            style={{ transform: `translate(-50%, -50%) translate(${labelX + 26}px,${labelY}px)` }}
          >
            ↻ {backoff}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// "group" is a React Flow built-in type with its own border; ours is named differently to avoid it.
const nodeTypes = { step: StepNode, attempt: AttemptNode, retryGroup: GroupNode, artifact: ArtifactNode };
const edgeTypes = { run: RunEdge };

/** Keeps the graph centred when the canvas resizes (a side panel opening, a window resize). */
export function AutoFit({ signature }: { signature: string }) {
  const { fitView } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  // Layout is asynchronous, so fit once the laid-out nodes have been measured, not at mount.
  const initialized = useNodesInitialized();
  useEffect(() => {
    if (!width || !height || !initialized) return;
    const id = window.setTimeout(() => void fitView({ duration: 200, maxZoom: 0.9, padding: 0.2 }), 30);
    return () => window.clearTimeout(id);
  }, [width, height, fitView, signature, initialized]);
  return null;
}

export function RunGraph({
  workflow,
  selectedNodeId,
  selectedArtifact,
  expandRetries,
  showArtifacts,
  onSelectNode,
  onSelectArtifact,
}: {
  workflow: Workflow;
  selectedNodeId?: string;
  selectedArtifact?: ArtifactRef;
  expandRetries: boolean;
  showArtifacts: boolean;
  onSelectNode: (node: NodeStatus) => void;
  onSelectArtifact: (ref: ArtifactRef) => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.resolved);
  const running = workflow.status?.phase === "Running";
  const now = useNow(running);

  const graph = useMemo(
    () =>
      buildRuntimeGraph(workflow, {
        expandRetries,
        showArtifacts,
        retryLimit: (node) => {
          const limit = (resolveTemplate(workflow, node)?.retryStrategy as { limit?: number | string } | undefined)?.limit;
          return limit === undefined ? undefined : Number(limit);
        },
      }),
    [workflow, expandRetries, showArtifacts],
  );
  // Layout depends only on the shape, not on phases, so a running workflow does not re-layout on every
  // status update.
  const shape = useMemo(() => graph.nodes.map((n) => `${n.id}:${n.parent ?? ""}`).join("|") + "#" + graph.edges.map((e) => e.id).join("|"), [graph]);
  const [positions, setPositions] = useState<Map<string, { x: number; y: number; width: number; height: number }>>();
  useEffect(() => {
    let cancelled = false;
    void layoutGraph(
      graph.nodes.map((n) => ({ id: n.id, width: n.width, height: n.height, parent: n.parent })),
      graph.edges.filter((e) => {
        // ELK lays out edges inside a group separately from edges that cross it.
        const s = graph.nodes.find((n) => n.id === e.source);
        const tgt = graph.nodes.find((n) => n.id === e.target);
        return (s?.parent ?? "") === (tgt?.parent ?? "");
      }),
    ).then((p) => !cancelled && setPositions(p));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  const selectedArtifactId = selectedArtifact ? `artifact::${selectedArtifact.isInput ? "in" : "out"}::${selectedArtifact.nodeId}::${selectedArtifact.name}` : undefined;
  const flowNodes: Node[] = useMemo(() => {
    if (!positions) return [];
    return graph.nodes
      .filter((n) => positions.has(n.id))
      .map((n) => {
        const p = positions.get(n.id)!;
        const parent = n.parent ? positions.get(n.parent) : undefined;
        return {
          id: n.id,
          type: n.data.kind === "group" ? "retryGroup" : n.data.kind,
          parentId: n.parent,
          position: parent ? { x: p.x - parent.x, y: p.y - parent.y } : { x: p.x, y: p.y },
          style: { width: p.width, height: p.height },
          draggable: false,
          selectable: true,
          zIndex: n.data.kind === "group" ? 0 : 1,
          data: { ...n.data, selected: n.id === selectedNodeId || n.id === selectedArtifactId, now } as FlowData,
        };
      });
  }, [graph, positions, selectedNodeId, selectedArtifactId, now]);

  const flowEdges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "run",
        animated: e.animated,
        data: { backoff: e.backoff },
        zIndex: 1,
        style: {
          stroke: e.failed ? "var(--phase-fail-solid)" : "var(--muted-foreground)",
          strokeOpacity: e.failed ? 0.8 : 0.45,
          strokeWidth: 1.5,
          strokeDasharray: e.dashed ? "4 4" : undefined,
        },
      })),
    [graph],
  );

  if (!graph.nodes.length) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("This workflow has no nodes yet.")}</div>;
  }

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode={theme}
      minZoom={0.1}
      maxZoom={2}
      fitView
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      onNodeClick={(_e, node) => {
        const data = node.data as FlowData;
        if (data.kind === "artifact") onSelectArtifact(data.ref);
        else if (data.kind === "step") onSelectNode(data.retry?.attempts.at(-1) ?? data.status);
        else onSelectNode(data.status);
      }}
    >
      <AutoFit signature={shape} />
      <Background gap={16} size={1} />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}
