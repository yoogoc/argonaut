import "@xyflow/react/dist/style.css";

import {
  Background,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  Handle,
  MarkerType,
  Panel,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { ChevronRight, LayoutGrid, Settings2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Component } from "@/api/templates";
import { Button } from "@/components/ui/button";
import { KindIcon, KINDS } from "@/graph/kinds";
import { layoutGraph } from "@/graph/layout";
import { exitNode, findTemplate, type SpecNode, standaloneTemplates, templateGraph } from "@/graph/spec";
import { canvasNavigation } from "@/graph/viewport";
import { cn } from "@/lib/utils";
import { useTheme } from "@/stores/theme";

import { addComponentNode, addKindNode, connect, deleteTask, disconnect, ensureDag, moveNodes, positionsOf } from "./ops";
import { specOf, useEditor } from "./store";

export const NODE_W = 196;
export const NODE_H = 56;
export const DRAG_MIME = "application/x-argonaut-node";
/** How many standalone templates a row holds before the next row starts. */
const STANDALONE_COLUMNS = 3;

/** What the palette puts on the drag: a basic kind, or a component in one of the two modes. */
export type DragPayload = { kind: SpecNode["kind"] } | { component: Component; mode: "ref" | "snapshot" };

type NodeData = {
  node: SpecNode;
  selected: boolean;
  problems: string[];
  status?: string;
  horizontal: boolean;
};

const statusTone: Record<string, string> = {
  Succeeded: "bg-phase-ok-solid",
  Failed: "bg-phase-fail-solid",
  Error: "bg-phase-fail-solid",
  Running: "bg-phase-run-solid",
};

const TaskNode = memo(function TaskNode({ data }: NodeProps) {
  const { t } = useTranslation();
  const d = data as NodeData;
  const { node } = d;
  const task = node.task;
  const tpl = node.template as Record<string, unknown> | undefined;
  const loop = task.withItems ? `withItems ×${task.withItems.length}` : task.withParam !== undefined ? "withParam" : task.withSequence ? "withSequence" : undefined;
  const tags: { label: string; tone: string }[] = [];
  if (d.problems.length) tags.push({ label: t("{{n}} problems", { count: d.problems.length, n: d.problems.length }), tone: "bg-destructive text-white" });
  else {
    if (node.entry) tags.push({ label: t("Entrypoint"), tone: "bg-muted text-muted-foreground border" });
    if (task.templateRef?.clusterScope) tags.push({ label: t("cluster"), tone: "bg-foreground text-background" });
    else if (task.templateRef) tags.push({ label: "templateRef", tone: "bg-node-ref-bg text-node-ref border border-node-ref/30" });
    if (loop) tags.push({ label: loop, tone: "bg-node-ref-bg text-node-ref border border-node-ref/30" });
    if (tpl?.retryStrategy) tags.push({ label: "retry", tone: "bg-phase-susp-bg text-phase-susp border border-phase-susp-solid/30" });
    if (tpl?.memoize) tags.push({ label: "memoize", tone: "bg-muted text-muted-foreground border" });
    if (task.when) tags.push({ label: "when", tone: "bg-muted text-muted-foreground border" });
  }
  const sub = task.templateRef ? task.templateRef.name : sublineOf(node);
  return (
    <div
      className={cn(
        "relative flex h-full w-full items-center gap-2.5 rounded-xl border bg-card px-3 shadow-xs",
        node.exit && "border-dashed",
        d.problems.length > 0 && "border-2 border-destructive",
        d.selected && "border-2 border-primary ring-4 ring-primary/15",
      )}
      title={d.problems.join("\n") || undefined}
    >
      <Handle type="target" position={d.horizontal ? Position.Left : Position.Top} className="!size-2.5 !border-2 !border-card !bg-muted-foreground/60" />
      {tags.length > 0 && (
        <span className="absolute -top-2.5 right-2 flex gap-1">
          {tags.slice(0, 2).map((tag) => (
            <span key={tag.label} className={cn("flex h-[18px] items-center rounded-full px-1.5 text-[10px] font-semibold", tag.tone)}>
              {tag.label}
            </span>
          ))}
        </span>
      )}
      <KindIcon kind={node.kind} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-mono text-xs font-semibold">{node.id}</span>
        <span className="truncate text-[11px] text-muted-foreground">
          {t(KINDS[node.kind].label)}
          {sub ? ` · ${sub}` : ""}
        </span>
      </span>
      {d.status && <span aria-label={t(d.status)} className={cn("absolute -bottom-1.5 -left-1.5 size-3.5 rounded-full border-2 border-card", statusTone[d.status] ?? "bg-phase-pend-solid")} />}
      <Handle type="source" position={d.horizontal ? Position.Right : Position.Bottom} className="!size-2.5 !border-2 !border-card !bg-muted-foreground/60" />
    </div>
  );
});

function sublineOf(node: SpecNode): string {
  const tpl = node.template as Record<string, Record<string, unknown> | undefined> | undefined;
  if (!tpl) return "";
  const c = tpl.container ?? tpl.script;
  if (c?.image) return String(c.image);
  if (tpl.http) return `${String(tpl.http.method ?? "GET")}`;
  if (tpl.resource) return String(tpl.resource.action ?? "");
  if (tpl.dag) return `${((tpl.dag.tasks as unknown[]) ?? []).length} tasks`;
  if (tpl.steps) return `${((tpl.steps as unknown as unknown[]) ?? []).length} groups`;
  if (tpl.plugin) return Object.keys(tpl.plugin)[0] ?? "";
  return node.template?.name ?? "";
}

const nodeTypes = { task: TaskNode };

/**
 * The editing canvas (DESIGN §3.1–3.2): the current DAG template's tasks, edited in place. Every
 * gesture is one patch — moving a node rewrites only the layout annotation, connecting two nodes only
 * the target's `depends`.
 */
export function EditorCanvas(props: { problems: Record<string, string[]>; status?: (task: string) => string | undefined; onDropPayload?: () => void }) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function CanvasInner({ problems, status }: { problems: Record<string, string[]>; status?: (task: string) => string | undefined }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.resolved);
  const obj = useEditor((s) => s.obj);
  const selection = useEditor((s) => s.selection);
  const canvasTemplate = useEditor((s) => s.canvasTemplate);
  const frozen = useEditor((s) => !!s.yamlError);
  const apply = useEditor((s) => s.apply);
  const select = useEditor((s) => s.select);
  const flow = useReactFlow();
  const spec = specOf(obj);
  const current = canvasTemplate ?? spec.entrypoint;
  const graph = useMemo(() => templateGraph(spec, current), [spec, current]);
  const exit = current === spec.entrypoint ? exitNode(spec) : undefined;
  const saved = positionsOf(obj, current ?? "");
  const isSteps = graph.kind === "steps";
  // An entry template that is a single step (a container, script, suspend…, as components usually are)
  // has no tasks to draw. Every template of the spec is shown as a node of its own instead, the entry
  // first, each edited directly: a component is often a library of step variants used by templateRef.
  const standalone = useMemo(() => (graph.kind === "none" && current === spec.entrypoint ? standaloneTemplates(spec, current) : []), [graph.kind, current, spec]);
  const single = standalone.length > 0;

  // Tasks without a saved position are placed by ELK; saved positions always win.
  const [auto, setAuto] = useState<Map<string, { x: number; y: number }>>(new Map());
  const shape = graph.nodes.map((n) => n.id).join("|") + "#" + graph.edges.map((e) => e.id).join("|");
  useEffect(() => {
    let cancelled = false;
    void layoutGraph(
      graph.nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
      graph.edges,
    ).then((p) => !cancelled && setAuto(p));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  const [dragging, setDragging] = useState<Record<string, { x: number; y: number }>>({});
  const position = (id: string) => dragging[id] ?? (saved[id] ? { x: saved[id][0], y: saved[id][1] } : auto.get(id)) ?? { x: 0, y: 0 };
  const maxY = Math.max(0, ...graph.nodes.map((n) => position(n.id).y), Math.ceil(standalone.length / STANDALONE_COLUMNS - 1) * (NODE_H + 48));
  const selectedId =
    selection?.kind === "task" && selection.template === current
      ? selection.id
      : selection?.kind === "exit"
        ? `exit:${selection.template}`
        : selection?.kind === "template"
          ? `template:${selection.template}`
          : undefined;

  const nodes: Node[] = [
    ...standalone.map((n, i) => {
      const id = `template:${n.id}`;
      return {
        id,
        type: "task",
        position: { x: (i % STANDALONE_COLUMNS) * (NODE_W + 48), y: Math.floor(i / STANDALONE_COLUMNS) * (NODE_H + 48) },
        width: NODE_W, height: NODE_H, style: { width: NODE_W, height: NODE_H },
        data: { node: n, selected: id === selectedId, problems: problems[id] ?? [], status: status?.(n.id), horizontal: false } satisfies NodeData,
        draggable: false,
        connectable: false,
        deletable: false,
      };
    }),
    ...graph.nodes.map((n) => ({
      id: n.id,
      type: "task",
      position: position(n.id),
      width: NODE_W, height: NODE_H, style: { width: NODE_W, height: NODE_H },
      data: { node: n, selected: n.id === selectedId, problems: problems[n.id] ?? [], status: status?.(n.id), horizontal: false } satisfies NodeData,
      draggable: !frozen,
      connectable: !frozen && !isSteps,
    })),
    ...(exit
      ? [
          {
            id: `exit:${exit.id}`,
            type: "task",
            position: saved[`exit:${exit.id}`] ? { x: saved[`exit:${exit.id}`][0], y: saved[`exit:${exit.id}`][1] } : { x: 0, y: maxY + 130 },
            width: NODE_W, height: NODE_H, style: { width: NODE_W, height: NODE_H },
            data: { node: exit, selected: `exit:${exit.id}` === selectedId, problems: problems[`exit:${exit.id}`] ?? [], horizontal: false } satisfies NodeData,
            draggable: !frozen,
            connectable: false,
          },
        ]
      : []),
  ];
  const edges: Edge[] = graph.edges.map((e) => {
    const failure = e.condition === "Failed" || e.condition === "Errored" || e.condition === "AllFailed";
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.condition,
      deletable: !frozen && !isSteps,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: failure ? "var(--phase-fail-solid)" : "var(--muted-foreground)" },
      labelBgPadding: [5, 2] as [number, number],
      labelBgBorderRadius: 999,
      labelStyle: { fontSize: 11, fontWeight: 600, fill: failure ? "var(--phase-fail)" : undefined },
      style: { stroke: failure ? "var(--phase-fail-solid)" : "var(--muted-foreground)", strokeOpacity: failure ? 0.9 : 0.55, strokeWidth: 1.5, strokeDasharray: failure ? "5 4" : undefined },
    };
  });

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const moves: Record<string, [number, number]> = {};
      const live: Record<string, { x: number; y: number }> = {};
      for (const c of changes) {
        if (c.type === "position" && c.position) {
          if (c.dragging) live[c.id] = c.position;
          else moves[c.id] = [c.position.x, c.position.y];
        }
        if (c.type === "remove" && current && !c.id.startsWith("template:")) {
          if (c.id.startsWith("exit:")) apply("delete exit", (draft) => void delete (draft.spec as Record<string, unknown>).onExit);
          else apply("delete task", (draft) => deleteTask(draft, current, c.id));
          if (selectedId === c.id) select(undefined);
        }
      }
      if (Object.keys(live).length) setDragging((d) => ({ ...d, ...live }));
      if (Object.keys(moves).length && current) {
        setDragging({});
        apply("move", (draft) => moveNodes(draft, current, moves));
      }
    },
    [apply, current, select, selectedId],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const c of changes) {
        if (c.type !== "remove" || !current) continue;
        const edge = graph.edges.find((e) => e.id === c.id);
        if (edge) apply("disconnect", (draft) => disconnect(draft, current, edge.source, edge.target));
      }
    },
    [apply, current, graph.edges],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!current || !c.source || !c.target || c.source.startsWith("exit:") || c.target.startsWith("exit:")) return;
      apply("connect", (draft) => connect(draft, current, c.source!, c.target!));
    },
    [apply, current],
  );

  const wrapper = useRef<HTMLDivElement>(null);
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData(DRAG_MIME);
    if (!raw || !current || frozen) return;
    const payload = JSON.parse(raw) as DragPayload;
    const p = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const pos: [number, number] = [p.x - NODE_W / 2, p.y - NODE_H / 2];
    let added = "";
    let target = current;
    apply("add node", (draft) => {
      target = ensureDag(draft, current);
      added = "kind" in payload ? addKindNode(draft, target, payload.kind, pos) : addComponentNode(draft, target, (payload.component.cluster ? payload.component.clusterTemplate : payload.component.template)!, !!payload.component.cluster, payload.mode, pos);
    });
    if (added) select({ kind: "task", template: target, id: added });
  };

  const relayout = () => {
    if (!current) return;
    void layoutGraph(graph.nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })), graph.edges).then((p) => {
      const moves: Record<string, [number, number]> = {};
      p.forEach((v, k) => (moves[k] = [v.x, v.y]));
      apply("auto layout", (draft) => moveNodes(draft, current, moves));
      requestAnimationFrame(() => void flow.fitView({ duration: 250, padding: 0.2, maxZoom: 1 }));
    });
  };

  // Fit once when the template on the canvas changes and its nodes have positions.
  const fitted = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (fitted.current === current || (!auto.size && graph.nodes.length && !Object.keys(saved).length)) return;
    fitted.current = current;
    requestAnimationFrame(() => void flow.fitView({ padding: 0.2, maxZoom: 1 }));
  }, [current, auto, flow, graph.nodes.length, saved]);

  const trail = breadcrumb(spec, current);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b bg-background/60 px-3 py-2">
        <Button variant={selection?.kind === "workflow" ? "secondary" : "outline"} size="sm" onClick={() => select({ kind: "workflow" })} aria-pressed={selection?.kind === "workflow"}>
          <Settings2 aria-hidden />
          {t("Workflow settings")}
        </Button>
        <Button variant="outline" size="sm" onClick={relayout} disabled={frozen}>
          <LayoutGrid aria-hidden />
          {t("Auto layout")}
        </Button>
        {trail.length > 1 && (
          <nav aria-label={t("Template path")} className="flex items-center gap-1 text-[13px]">
            {trail.map((name, i) => (
              <span key={name} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />}
                <button type="button" className={cn("font-mono", i === trail.length - 1 ? "font-semibold" : "text-primary hover:underline")} onClick={() => useEditor.getState().openTemplate(i === 0 ? undefined : name)}>
                  {name}
                </button>
              </span>
            ))}
          </nav>
        )}
        <span className="ml-auto hidden text-xs text-muted-foreground md:inline">
          {frozen ? t("The YAML does not parse; the canvas is frozen until it does.") : single ? t("Single-step templates: select one to edit it. Adding a node wraps the entry in a DAG.") : isSteps ? t("Steps template: edit the groups in the panel.") : t("Drag from the palette · connect handles to add a dependency · Delete removes")}
        </span>
      </div>
      <div ref={wrapper} className="min-h-0 flex-1" onDragOver={(e) => (e.preventDefault(), (e.dataTransfer.dropEffect = "copy"))} onDrop={onDrop}>
        {graph.kind === "none" && !single ? (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
            {spec.entrypoint ? t("The entry template {{name}} is not defined in this template.", { name: spec.entrypoint }) : t("This template has no entrypoint yet.")}
          </div>
        ) : (
          <ReactFlow
            {...canvasNavigation}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode={theme}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_e, node) =>
              node.id.startsWith("exit:")
                ? select({ kind: "exit", template: node.id.slice(5) })
                : node.id.startsWith("template:")
                  ? select({ kind: "template", template: node.id.slice(9) })
                  : current && select({ kind: "task", template: current, id: node.id })
            }
            onNodeDoubleClick={(_e, node) => {
              const n = (node.data as NodeData).node;
              if ((n.kind === "dag" || n.kind === "steps") && n.task.template) useEditor.getState().openTemplate(n.task.template);
            }}
            onPaneClick={() => select(undefined)}
            deleteKeyCode={["Delete", "Backspace"]}
            minZoom={0.2}
            maxZoom={1.5}
            snapToGrid
            snapGrid={[8, 8]}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} size={1} />
            <Controls position="bottom-left" showInteractive={false} />
            {graph.nodes.length === 0 && !single && (
              <Panel position="top-center" className="pointer-events-none !mt-24 rounded-lg border border-dashed bg-background/80 px-4 py-3 text-center text-sm text-muted-foreground">
                {t("Drag a node from the palette, or click one, to start.")}
              </Panel>
            )}
          </ReactFlow>
        )}
      </div>
    </div>
  );
}

/** The chain of templates from the entrypoint to the one shown, for drill-in navigation. */
function breadcrumb(spec: ReturnType<typeof specOf>, current?: string): string[] {
  if (!spec.entrypoint || !current) return [];
  if (current === spec.entrypoint) return [current];
  const parentOf = (name: string) =>
    (spec.templates ?? []).find((t) => t.dag?.tasks?.some((x) => x.template === name) || t.steps?.some((g) => g.some((x) => x.template === name)))?.name;
  const trail = [current];
  let cur: string | undefined = current;
  for (let i = 0; i < 10 && cur && cur !== spec.entrypoint; i++) {
    cur = parentOf(cur);
    if (cur) trail.unshift(cur);
  }
  if (trail[0] !== spec.entrypoint) trail.unshift(spec.entrypoint);
  return trail.filter((n, i, a) => a.indexOf(n) === i && !!findTemplate(spec, n));
}
