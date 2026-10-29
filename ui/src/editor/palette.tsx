import { useQuery } from "@tanstack/react-query";
import { Layers, Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { type Component, templateQueries } from "@/api/templates";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { KindIcon, KINDS } from "@/graph/kinds";
import type { NodeKind } from "@/graph/spec";
import { useNamespace } from "@/hooks/use-namespace";
import { cn } from "@/lib/utils";

import { DRAG_MIME, type DragPayload } from "./canvas";
import { addComponentNode, addKindNode, ensureDag } from "./ops";
import { specOf, useEditor } from "./store";

const EXEC: NodeKind[] = ["container", "script", "containerSet", "resource", "http", "data", "plugin"];
const CONTROL: NodeKind[] = ["suspend", "dag", "steps"];

/** The node palette: basic kinds and the component library (DESIGN §3.3). Drag onto the canvas, or click to add. */
export function Palette({ namespace: nsOverride }: { namespace?: string }) {
  const { t } = useTranslation();
  const { namespace: current } = useNamespace();
  const namespace = nsOverride ?? current;
  const components = useQuery(templateQueries.components(namespace));
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"ref" | "snapshot">("ref");
  const frozen = useEditor((s) => !!s.yamlError);
  const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());

  const add = (payload: DragPayload) => {
    const { obj, canvasTemplate, apply, select } = useEditor.getState();
    const entry = canvasTemplate ?? specOf(obj).entrypoint;
    if (!entry || frozen) return;
    let added = "";
    let target = entry;
    apply("add node", (draft) => {
      target = ensureDag(draft, entry);
      added = "kind" in payload ? addKindNode(draft, target, payload.kind) : addComponentNode(draft, target, (payload.component.cluster ? payload.component.clusterTemplate : payload.component.template)!, !!payload.component.cluster, payload.mode);
    });
    if (added) select({ kind: "task", template: target, id: added });
  };

  const item = (key: string, payload: DragPayload, icon: React.ReactNode, name: string, desc: string, mono = false) => (
    <button
      key={key}
      type="button"
      draggable={!frozen}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => add(payload)}
      disabled={frozen}
      className="flex w-full cursor-grab items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-1.5 text-left hover:border-border hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      title={t("Drag onto the canvas, or click to add")}
    >
      {icon}
      <span className="flex min-w-0 flex-col">
        <span className={cn("truncate text-[13px] font-semibold", mono && "font-mono text-xs")}>{name}</span>
        <span className="truncate text-xs text-muted-foreground">{desc}</span>
      </span>
    </button>
  );

  const comps = (components.data ?? []).filter((c) => match((c.cluster ? c.clusterTemplate : c.template)?.metadata.name ?? ""));
  const group = (title: string, children: React.ReactNode[]) =>
    children.length > 0 && (
      <div className="flex flex-col gap-0.5">
        <h2 className="px-2.5 pb-1 text-xs font-semibold text-muted-foreground">{title}</h2>
        {children}
      </div>
    );
  const compItem = (c: Component) => {
    const tpl = (c.cluster ? c.clusterTemplate : c.template)!;
    return item(`${c.cluster}/${tpl.metadata.name}`, { component: c, mode }, <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-node-ref-bg text-node-ref"><Layers className="size-4" /></span>, tpl.metadata.name, tpl.metadata.annotations?.["argonaut.io/description"] ?? tpl.metadata.annotations?.["argonaut.io/category"] ?? t("Component"), true);
  };

  return (
    <aside aria-label={t("Node palette")} className="flex h-full min-h-0 flex-col gap-3 overflow-auto bg-card p-2.5">
      <label className="relative">
        <span className="sr-only">{t("Search nodes and components")}</span>
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search nodes and components")} className="h-8 pl-8 text-xs" />
      </label>
      {group(
        t("Run"),
        EXEC.filter((k) => match(KINDS[k].label)).map((k) => item(k, { kind: k }, <KindIcon kind={k} />, t(KINDS[k].label), t(KINDS[k].description))),
      )}
      {group(
        t("Control"),
        CONTROL.filter((k) => match(KINDS[k].label)).map((k) => item(k, { kind: k }, <KindIcon kind={k} />, t(KINDS[k].label), t(KINDS[k].description))),
      )}
      <div className="flex flex-col gap-1.5 border-t pt-3">
        <div className="flex items-center gap-2 px-1">
          <span className="text-xs font-semibold text-muted-foreground">{t("Add components as")}</span>
          <ToggleGroup type="single" size="sm" variant="outline" value={mode} onValueChange={(v) => v && setMode(v as "ref" | "snapshot")} className="ml-auto">
            <ToggleGroupItem value="ref" className="h-6 px-2 text-[11px]" title={t("templateRef: follows the component's updates")}>
              {t("Reference")}
            </ToggleGroupItem>
            <ToggleGroupItem value="snapshot" className="h-6 px-2 text-[11px]" title={t("Copies the component in and pins this version")}>
              {t("Snapshot")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {group(`${t("Components")} · ${namespace}`, comps.filter((c) => !c.cluster).map(compItem))}
        {group(t("Components · cluster"), comps.filter((c) => c.cluster).map(compItem))}
        {!components.isPending && comps.length === 0 && <p className="px-2.5 text-xs text-muted-foreground">{t("No components. Label a template argonaut.io/component=true to add one.")}</p>}
      </div>
    </aside>
  );
}
