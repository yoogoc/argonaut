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
  type NodeHandle,
  type NodeProps,
  Position,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { ArrowDownToLine, ArrowUpFromLine, Database, LogOut, RotateCcw, Zap } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { NodeStatus, Workflow } from "@/api/types";
import { phaseTone, toneSolid } from "@/components/common/phase-badge";
import { layoutGraph } from "@/graph/layout";
import { type ArtifactRef, buildRuntimeGraph, HOOK_GAP, HOOK_HEIGHT, HOOK_STACK_GAP, HOOK_WIDTH, type RuntimeNode, type RuntimeNodeData } from "@/graph/runtime";
import { canvasNavigation } from "@/graph/viewport";
import { useNow } from "@/hooks/use-now";
import { formatDuration } from "@/lib/format";
import { resolveTemplate } from "@/lib/template";
import { cn } from "@/lib/utils";
import { useTheme } from "@/stores/theme";

// selectedAttempt: the attempt open in the node panel, when it is drawn inside this collapsed Retry card.
type FlowData = RuntimeNodeData & { selected: boolean; selectedAttempt?: string; now: number };

/**
 * Where each node's connection points are, declared from its size: top and bottom for the flow, and on
 * steps a right-hand point for the connector to their hooks.
 */
function handlesFor(kind: RuntimeNodeData["kind"], width: number, height: number): NodeHandle[] {
  if (kind === "hook") return [{ id: "hook-in", type: "target", position: Position.Left, x: 0, y: height / 2, width: 1, height: 1 }];
  const flow: NodeHandle[] = [
    { type: "target", position: Position.Top, x: width / 2, y: 0, width: 1, height: 1 },
    { type: "source", position: Position.Bottom, x: width / 2, y: height - 1, width: 1, height: 1 },
  ];
  if (kind === "step" || kind === "group") flow.push({ id: "hook", type: "source", position: Position.Right, x: width - 1, y: kind === "group" ? 16 : height / 2, width: 1, height: 1 });
  return flow;
}

function StatusDot({ phase, className }: { phase?: string; className?: string }) {
  const tone = phaseTone(phase);
  if (phase === "Running") {
    // A spinning arc around a solid core: visibly alive without the whole card moving.
    return (
      <span aria-hidden className={cn("relative flex size-5 shrink-0 items-center justify-center", className)}>
        <span className="absolute inset-0 rounded-full border-2 border-phase-run-solid/25 border-t-phase-run-solid motion-safe:animate-spin" />
        <span className="size-2 rounded-full bg-phase-run-solid" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn("flex size-5 shrink-0 items-center justify-center rounded-full", toneSolid[tone], tone === "pend" && "bg-transparent ring-2 ring-phase-pend-solid ring-inset", className)}
    />
  );
}

/** A lifecycle hook or exit handler: a small pill beside its step, clearly not a step itself. */
const HookNode = memo(function HookNode({ data }: NodeProps) {
  const { t } = useTranslation();
  const d = data as FlowData & { kind: "hook" };
  const s = d.status;
  const tone = phaseTone(s.phase);
  const Icon = d.event === "exit" ? LogOut : Zap;
  return (
    <div
      className={cn(
        "flex h-full w-full items-center gap-1 rounded-full border bg-card/90 pr-2 pl-1 text-[10px] text-muted-foreground shadow-xs",
        s.phase === "Running" && "border-phase-run-solid/60",
        tone === "fail" && "border-phase-fail-solid/50 text-phase-fail",
        d.selected && "border-primary ring-2 ring-primary/20",
      )}
      title={`${d.event === "exit" ? t("Exit handler") : t("Hook {{event}}", { event: d.event })} — ${t(s.phase ?? "Pending")}`}
    >
      <Handle id="hook-in" type="target" position={Position.Left} className="!size-1 !border-0 !bg-transparent" />
      <StatusDot phase={s.phase} className="size-3.5 [&>span:last-child]:size-1.5" />
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate font-mono font-medium">{d.event}</span>
      {s.startedAt && <span className="ml-auto shrink-0 font-mono opacity-70">{formatDuration(s.startedAt, s.finishedAt, d.now)}</span>}
    </div>
  );
});

/** One dot per retry attempt: hollow red for failed, solid for the rest. */
function AttemptDots({ attempts, selected }: { attempts: NodeStatus[]; selected?: string }) {
  return (
    <span className="flex items-center gap-0.5" aria-hidden>
      {attempts.map((a) => {
        const tone = phaseTone(a.phase);
        return (
          <span
            key={a.id}
            className={cn(
              "size-2 rounded-full",
              tone === "fail" ? "border-2 border-phase-fail-solid bg-phase-fail-bg" : toneSolid[tone],
              a.id === selected && "ring-2 ring-primary ring-offset-1 ring-offset-card",
            )}
          />
        );
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
  const selectedIndex = retry?.attempts.findIndex((a) => a.id === d.selectedAttempt) ?? -1;
  const cached = s.memoizationStatus?.hit === true;
  const running = shown.phase === "Running";
  return (
    <div
      className={cn(
        "relative flex h-full w-full items-center gap-2 rounded-[10px] border bg-card px-2.5 text-left shadow-xs",
        running && "node-running border-phase-run-solid/60",
        d.selected && "border-2 border-primary ring-4 ring-primary/15",
        !d.selected && shown.phase === "Pending" && "border-dashed",
      )}
      title={`${s.displayName || s.name} — ${shown.phase ?? "Pending"}`}
    >
      {/* Clipped on its own, so the card itself can let the retry and cache badges overhang its top edge. */}
      {running && (
        <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-[9px]">
          <span className="node-progress absolute inset-x-0 bottom-0 h-0.5" />
        </span>
      )}
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
          {retry && retry.attempts.length > 1 && <AttemptDots attempts={retry.attempts} selected={d.selectedAttempt} />}
          {retry && retry.attempts.length > 1
            ? t("Attempt {{n}}", { n: selectedIndex >= 0 ? selectedIndex + 1 : retry.attempts.length })
            : shown.phase === "Pending" || !shown.startedAt
              ? t(s.type)
              : `${running ? t("running") + " " : ""}${formatDuration(shown.startedAt, shown.finishedAt, d.now)}`}
        </span>
      </span>
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-muted-foreground/50" />
      <Handle id="hook" type="source" position={Position.Right} className="!size-1 !border-0 !bg-transparent" />
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
    <div
      className={cn("flex h-full w-full items-center gap-2 rounded-lg border bg-card px-2.5", failed && "border-phase-fail-solid/50", d.selected && "border-2 border-primary ring-4 ring-primary/15")}
    >
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
      <Handle id="hook" type="source" position={Position.Right} style={{ top: 16 }} className="!size-1 !border-0 !bg-transparent" />
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
const nodeTypes = { step: StepNode, attempt: AttemptNode, retryGroup: GroupNode, artifact: ArtifactNode, hook: HookNode };
const edgeTypes = { run: RunEdge };

/**
 * Keeps the graph centred in the space it has: when the layout first lands, when its shape changes, and
 * whenever the canvas is resized (a side panel opening or closing, a window resize). The canvas element
 * is observed directly; React Flow's own size state did not follow a panel opening beside it.
 */
export function AutoFit({ signature }: { signature: string }) {
  const { fitView } = useReactFlow();
  const domNode = useStore((s) => s.domNode);
  // Layout is asynchronous, so fit once the laid-out nodes have their sizes, not at mount.
  const initialized = useNodesInitialized();
  const fit = useRef(fitView);
  fit.current = fitView;

  useEffect(() => {
    if (!initialized) return;
    const id = window.setTimeout(() => void fit.current({ duration: 200, maxZoom: 0.9, padding: 0.2 }), 30);
    return () => window.clearTimeout(id);
  }, [signature, initialized]);

  useEffect(() => {
    if (!domNode || !initialized) return;
    let timer = 0;
    let last = "";
    const observer = new ResizeObserver(([entry]) => {
      const size = `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
      if (size === last) return;
      const first = last === "";
      last = size;
      if (first) return;
      // Wait for the resize to settle (a panel animating open) before fitting once.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void fit.current({ duration: 250, maxZoom: 0.9, padding: 0.2 }), 60);
    });
    observer.observe(domNode);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [domNode, initialized]);
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
    // Hooks are not laid out as steps: their owner reserves room on its right and the pills are placed
    // there afterwards, so they never push the flow apart or overlap a neighbour.
    const hooksOf = new Map<string, RuntimeNode[]>();
    for (const n of graph.nodes) {
      if (n.data.kind !== "hook") continue;
      hooksOf.set(n.data.owner, [...(hooksOf.get(n.data.owner) ?? []), n]);
    }
    const stackHeight = (k: number) => k * HOOK_HEIGHT + (k - 1) * HOOK_STACK_GAP;
    const laidOut = graph.nodes.filter((n) => n.data.kind !== "hook");
    void layoutGraph(
      laidOut.map((n) => {
        const k = hooksOf.get(n.id)?.length ?? 0;
        // A group's size comes from its children, so only plain cards reserve room for their hooks.
        if (!k || n.data.kind === "group") return { id: n.id, width: n.width, height: n.height, parent: n.parent };
        return { id: n.id, width: n.width + HOOK_GAP + HOOK_WIDTH, height: Math.max(n.height, stackHeight(k)), parent: n.parent };
      }),
      graph.edges.filter((e) => {
        if (e.hook) return false;
        // ELK lays out edges inside a group separately from edges that cross it.
        const s = graph.nodes.find((n) => n.id === e.source);
        const tgt = graph.nodes.find((n) => n.id === e.target);
        return (s?.parent ?? "") === (tgt?.parent ?? "");
      }),
    ).then((p) => {
      if (cancelled) return;
      for (const [owner, hooks] of hooksOf) {
        const box = p.get(owner);
        const card = laidOut.find((n) => n.id === owner);
        if (!box || !card) continue;
        const isGroup = card.data.kind === "group";
        const cardHeight = isGroup ? box.height : card.height;
        const top = isGroup ? box.y : box.y + (box.height - cardHeight) / 2;
        if (!isGroup) p.set(owner, { x: box.x, y: top, width: card.width, height: card.height });
        const centre = top + cardHeight / 2;
        const right = box.x + (isGroup ? box.width : card.width) + HOOK_GAP;
        hooks.forEach((h, i) => p.set(h.id, { x: right, y: centre - stackHeight(hooks.length) / 2 + i * (HOOK_HEIGHT + HOOK_STACK_GAP), width: HOOK_WIDTH, height: HOOK_HEIGHT }));
      }
      setPositions(p);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  const selectedArtifactId = selectedArtifact ? `artifact::${selectedArtifact.isInput ? "in" : "out"}::${selectedArtifact.nodeId}::${selectedArtifact.name}` : undefined;
  // With retries collapsed an attempt has no card of its own, so selecting one (from the panel's attempt
  // switcher, or a link) highlights the Retry card that stands for it, and marks which attempt it is.
  const selectedCard = useMemo(() => {
    if (!selectedNodeId || graph.nodes.some((n) => n.id === selectedNodeId)) return { id: selectedNodeId };
    const card = graph.nodes.find((n) => n.data.kind === "step" && n.data.retry?.attempts.some((a) => a.id === selectedNodeId));
    return { id: card?.id, attempt: selectedNodeId };
  }, [graph, selectedNodeId]);
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
          // Explicit dimensions, not just a style: these node objects are rebuilt every second while a run
          // is live, and React Flow drops the sizes it measured whenever a node object changes. Without
          // width/height it would hide the nodes until a re-measure that never comes (their DOM size is
          // unchanged), leaving the canvas empty and the auto-fit waiting forever.
          width: p.width,
          height: p.height,
          // Declared, not measured, for the same reason: React Flow forgets measured handle positions when a
          // node object is replaced, and every edge touching the node disappears until it re-measures.
          measured: { width: p.width, height: p.height },
          handles: handlesFor(n.data.kind, p.width, p.height),
          style: { width: p.width, height: p.height },
          draggable: false,
          selectable: true,
          zIndex: n.data.kind === "group" ? 0 : 1,
          data: {
            ...n.data,
            selected: n.id === selectedCard.id || n.id === selectedArtifactId,
            selectedAttempt: n.id === selectedCard.id ? selectedCard.attempt : undefined,
            now,
          } as FlowData,
        };
      });
  }, [graph, positions, selectedCard, selectedArtifactId, now]);

  const flowEdges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.hook ? "hook" : undefined,
        targetHandle: e.hook ? "hook-in" : undefined,
        type: e.hook ? "straight" : "run",
        // React Flow's animated edge is a moving dash; a running step's incoming edges flow toward it.
        animated: e.animated,
        data: { backoff: e.backoff },
        zIndex: 1,
        style: {
          stroke: e.failed ? "var(--phase-fail-solid)" : e.animated ? "var(--phase-run-solid)" : "var(--muted-foreground)",
          strokeOpacity: e.failed ? 0.8 : e.animated ? 0.85 : e.hook ? 0.6 : 0.45,
          strokeWidth: e.hook ? 1.25 : 1.5,
          // A hook's connector is a few pixels long: solid, or it would not read as a line at all.
          strokeDasharray: e.animated || e.hook ? undefined : e.dashed ? "4 4" : undefined,
        },
      })),
    [graph],
  );

  if (!graph.nodes.length) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("This workflow has no nodes yet.")}</div>;
  }

  return (
    <ReactFlow
      {...canvasNavigation}
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
