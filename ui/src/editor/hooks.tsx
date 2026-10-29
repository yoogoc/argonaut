import { Handle, type NodeProps, Position } from "@xyflow/react";
import { LogOut, Plus, Zap } from "lucide-react";
import { memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { getIn } from "./doc";
import { addHook, type HookOwner, type HookTrigger, hooksPath, type SpecHook } from "./ops";
import { useEditor } from "./store";

// Lifecycle hooks on the canvas: a task's hooks are small pills to the right of its card, joined to it
// by a short line; the workflow's (spec.hooks) sit in a lane at the top of the canvas. Selecting a task
// shows a "+" under its hooks that adds one from a preset trigger.

export const HOOK_W = 128;
export const HOOK_H = 24;
export const HOOK_GAP = 16;
export const HOOK_STACK_GAP = 6;
export const HOOK_ADD = 20;

export const stackHeight = (n: number) => n * HOOK_H + Math.max(0, n - 1) * HOOK_STACK_GAP;

export const hookNodeId = (task: string, event: string) => `hook:${task}\u0000${event}`;

export type HookNodeData = { owner: HookOwner; event: string; hook: SpecHook; selected: boolean };
export type HookAddData = { owner: HookOwner };

/** Where a hook runs, for its tooltip: a template of this spec or a component. */
export function hookTarget(hook: SpecHook): string {
  if (hook.templateRef) return `${hook.templateRef.name ?? "?"} / ${hook.templateRef.template ?? "?"}`;
  return hook.template ?? "—";
}

export const HookNode = memo(function HookNode({ data }: NodeProps) {
  const d = data as HookNodeData;
  return (
    <HookPill event={d.event} hook={d.hook} selected={d.selected}>
      <Handle id="hook-in" type="target" position={Position.Left} isConnectable={false} className="!size-1 !border-0 !bg-transparent" />
    </HookPill>
  );
});

export function HookPill({ event, hook, selected, onClick, children }: { event: string; hook: SpecHook; selected: boolean; onClick?: () => void; children?: ReactNode }) {
  const exit = event === "exit";
  const Icon = exit ? LogOut : Zap;
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={`${event}${hook.expression ? ` · ${hook.expression}` : ""} → ${hookTarget(hook)}`}
      className={cn(
        "flex h-6 w-full min-w-0 items-center gap-1.5 rounded-full border bg-card px-2 text-[11px] shadow-xs",
        selected ? "border-2 border-primary ring-4 ring-primary/15" : "border-border",
        !hook.template && !hook.templateRef && "border-dashed border-destructive",
      )}
      style={onClick ? { width: HOOK_W } : undefined}
    >
      {children}
      <Icon className={cn("size-3 shrink-0", exit ? "text-muted-foreground" : "text-phase-susp")} aria-hidden />
      <span className="truncate font-mono">{event}</span>
    </Tag>
  );
}

/** The preset triggers a new hook can start from. */
function useTriggers(owner: HookOwner): { trigger: HookTrigger; label: string; hint: string }[] {
  const { t } = useTranslation();
  const subject = owner ? `tasks['${owner.task}']` : "workflow";
  return [
    { trigger: "running", label: t("When it starts running"), hint: `${subject}.status == "Running"` },
    { trigger: "succeeded", label: t("When it succeeds"), hint: `… == "Succeeded"` },
    { trigger: "failed", label: t("When it fails"), hint: `… == "Failed"` },
    { trigger: "exit", label: t("When it finishes"), hint: "exit" },
    { trigger: "custom", label: t("On a condition…"), hint: "expression" },
  ];
}

/** "+": adds a hook to its owner from a preset trigger and selects it. */
export function AddHookMenu({ owner, className, frozen }: { owner: HookOwner; className?: string; frozen?: boolean }) {
  const { t } = useTranslation();
  const triggers = useTriggers(owner);
  const hasExit = useEditor((s) => {
    const path = hooksPath(s.obj, owner);
    return !!path && !!(getIn(s.obj, path) as Record<string, unknown> | undefined)?.exit;
  });
  const add = (trigger: HookTrigger) => {
    const { apply, select } = useEditor.getState();
    let event = "";
    apply("add hook", (draft) => {
      event = addHook(draft, owner, trigger);
    });
    if (event) select({ kind: "hook", template: owner?.template, task: owner?.task, event });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={frozen}>
        <button
          type="button"
          aria-label={owner ? t("Add a hook to {{task}}", { task: owner.task }) : t("Add a workflow hook")}
          className={cn("nodrag nopan flex items-center justify-center rounded-full border border-dashed border-muted-foreground/50 bg-card text-muted-foreground hover:border-primary hover:text-primary", className)}
          style={{ width: HOOK_ADD, height: HOOK_ADD }}
        >
          <Plus className="size-3" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {triggers.map((x) => (
          <DropdownMenuItem key={x.trigger} disabled={x.trigger === "exit" && hasExit} onSelect={() => add(x.trigger)} className="flex items-center justify-between gap-3 text-xs">
            <span className="whitespace-nowrap">{x.label}</span>
            <span className="truncate font-mono text-[10px] text-muted-foreground">{x.hint}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const HookAddNode = memo(function HookAddNode({ data }: NodeProps) {
  return <AddHookMenu owner={(data as HookAddData).owner} />;
});

/** The workflow's own hooks (spec.hooks), above the flow. */
export function WorkflowHookLane({ hooks, selected, frozen }: { hooks: Record<string, SpecHook>; selected?: string; frozen?: boolean }) {
  const { t } = useTranslation();
  const select = useEditor((s) => s.select);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed bg-background/85 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span>{t("Workflow hooks")}</span>
      {Object.entries(hooks).map(([event, hook]) => (
        <HookPill key={event} event={event} hook={hook} selected={selected === event} onClick={() => select({ kind: "hook", event })} />
      ))}
      <AddHookMenu owner={undefined} frozen={frozen} />
    </div>
  );
}
