import { Box, Boxes, Code2, FileText, Filter, Globe, Layers, ListOrdered, Network, Pause, Plug, type LucideIcon } from "lucide-react";

import type { NodeKind } from "./spec";

export interface KindInfo {
  label: string;
  /** Short description for the palette. */
  description: string;
  icon: LucideIcon;
  /** Tailwind classes for the icon tile, from the node-kind tokens in index.css. */
  tile: string;
  text: string;
  /** Whether a template of this kind runs a pod (decides which config tabs apply). */
  pod: boolean;
}

export const KINDS: Record<NodeKind, KindInfo> = {
  container: { label: "Container", description: "Image and command", icon: Box, tile: "bg-node-container-bg text-node-container", text: "text-node-container", pod: true },
  script: { label: "Script", description: "Image and inline source", icon: Code2, tile: "bg-node-script-bg text-node-script", text: "text-node-script", pod: true },
  containerSet: { label: "ContainerSet", description: "Several containers in one pod", icon: Boxes, tile: "bg-node-containerset-bg text-node-containerset", text: "text-node-containerset", pod: true },
  resource: { label: "Resource", description: "Create or change a Kubernetes resource", icon: FileText, tile: "bg-node-resource-bg text-node-resource", text: "text-node-resource", pod: true },
  http: { label: "HTTP", description: "An HTTP request, no pod", icon: Globe, tile: "bg-node-http-bg text-node-http", text: "text-node-http", pod: false },
  data: { label: "Data", description: "List and transform artifacts", icon: Filter, tile: "bg-node-data-bg text-node-data", text: "text-node-data", pod: true },
  plugin: { label: "Plugin", description: "An executor plugin", icon: Plug, tile: "bg-node-plugin-bg text-node-plugin", text: "text-node-plugin", pod: false },
  suspend: { label: "Suspend", description: "Approval or timed wait", icon: Pause, tile: "bg-node-suspend-bg text-node-suspend", text: "text-node-suspend", pod: false },
  dag: { label: "DAG", description: "A nested DAG", icon: Network, tile: "bg-node-dag-bg text-node-dag", text: "text-node-dag", pod: false },
  steps: { label: "Steps", description: "Groups run in sequence", icon: ListOrdered, tile: "bg-node-dag-bg text-node-dag", text: "text-node-dag", pod: false },
  ref: { label: "Component", description: "A referenced template", icon: Layers, tile: "bg-node-ref-bg text-node-ref", text: "text-node-ref", pod: false },
  unknown: { label: "Template", description: "", icon: Box, tile: "bg-muted text-muted-foreground", text: "text-muted-foreground", pod: false },
};

export function KindIcon({ kind, className }: { kind: NodeKind; className?: string }) {
  const info = KINDS[kind];
  const Icon = info.icon;
  return (
    <span aria-hidden className={`flex size-7 shrink-0 items-center justify-center rounded-[7px] ${info.tile} ${className ?? ""}`}>
      <Icon className="size-4" />
    </span>
  );
}
