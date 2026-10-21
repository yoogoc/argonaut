import { useTranslation } from "react-i18next";

import type { NodeStatus, Workflow } from "@/api/types";
import { EmptyState } from "@/components/common/states";
import { useNow } from "@/hooks/use-now";
import { formatDuration, formatSeconds } from "@/lib/format";
import { cn } from "@/lib/utils";

type Segment = { left: number; width: number; kind: "ok" | "fail" | "run" | "pend" | "back"; label: string; title: string; nodeId?: string };

/**
 * The Timeline tab: a Gantt of node durations. A step that retried is one row with a segment per
 * attempt and the backoff between them, so the time lost to retries is visible at a glance.
 */
export function Timeline({ workflow, onSelect, selectedId }: { workflow: Workflow; onSelect: (id: string) => void; selectedId?: string }) {
  const { t } = useTranslation();
  const now = useNow(workflow.status?.phase === "Running");
  const nodes = workflow.status?.nodes ?? {};
  const all = Object.values(nodes);
  const attemptIds = new Set(all.filter((n) => n.type === "Retry").flatMap((n) => n.children ?? []));
  const rows = all
    .filter((n) => (n.type === "Pod" || n.type === "Retry" || n.type === "Suspend" || n.type === "HTTP" || n.type === "Plugin" || n.type === "Container") && !attemptIds.has(n.id))
    .sort((a, b) => Date.parse(a.startedAt ?? "9999") - Date.parse(b.startedAt ?? "9999"));
  const started = all.filter((n) => n.startedAt);
  if (!started.length) return <EmptyState title={t("Nothing has started yet")} />;

  const start = Math.min(...started.map((n) => Date.parse(n.startedAt!)));
  const running = workflow.status?.phase === "Running" || workflow.status?.phase === "Pending";
  // A finished run ends at its last finish; only a running one extends to now.
  const end = Math.max(...started.map((n) => (n.finishedAt ? Date.parse(n.finishedAt) : now)), running ? now : 0);
  const span = Math.max(1000, end - start);
  const pct = (ms: number) => ((ms - start) / span) * 100;
  const ticks = Array.from({ length: 7 }, (_, i) => start + (span * i) / 6);

  const segmentsFor = (node: NodeStatus): Segment[] => {
    const attempts = node.type === "Retry" ? (node.children ?? []).map((id) => nodes[id]).filter(Boolean).sort((a, b) => Date.parse(a.startedAt ?? "") - Date.parse(b.startedAt ?? "")) : [node];
    const out: Segment[] = [];
    attempts.forEach((a, i) => {
      if (!a.startedAt) return;
      const from = Date.parse(a.startedAt);
      const to = a.finishedAt ? Date.parse(a.finishedAt) : now;
      const kind = a.phase === "Succeeded" ? "ok" : a.phase === "Failed" || a.phase === "Error" ? "fail" : a.phase === "Running" ? "run" : "pend";
      const label = attempts.length > 1 ? `#${i + 1}` : formatDuration(a.startedAt, a.finishedAt, now);
      out.push({ left: pct(from), width: Math.max(0.6, pct(to) - pct(from)), kind, label, title: `${a.displayName} · ${a.phase} · ${formatDuration(a.startedAt, a.finishedAt, now)}${a.message ? ` · ${a.message}` : ""}`, nodeId: a.id });
      const next = attempts[i + 1];
      if (next?.startedAt && a.finishedAt) {
        const gapFrom = Date.parse(a.finishedAt);
        const gapTo = Date.parse(next.startedAt);
        if (gapTo - gapFrom >= 1000)
          out.push({ left: pct(gapFrom), width: pct(gapTo) - pct(gapFrom), kind: "back", label: t("backoff"), title: `${t("backoff")} ${formatSeconds(Math.round((gapTo - gapFrom) / 1000))}` });
      }
    });
    return out;
  };

  const style: Record<Segment["kind"], string> = {
    ok: "bg-phase-ok-solid text-white",
    fail: "bg-phase-fail-solid text-white",
    run: "bg-[repeating-linear-gradient(135deg,var(--phase-run-solid)_0_6px,color-mix(in_oklch,var(--phase-run-solid)_80%,white)_6px_12px)] text-white",
    pend: "border border-dashed border-muted-foreground bg-muted text-foreground",
    back: "border border-phase-susp-solid bg-[repeating-linear-gradient(135deg,var(--phase-susp-bg)_0_4px,transparent_4px_8px)] text-phase-susp",
  };

  return (
    <div className="h-full overflow-auto rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-4 border-b px-4 py-3 text-xs text-muted-foreground">
        {(["ok", "fail", "run", "back", "pend"] as const).map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={cn("h-2.5 w-4 rounded-sm", style[k])} />
            {{ ok: t("Succeeded"), fail: t("Failed"), run: t("Running"), back: t("Retry backoff"), pend: t("Pending") }[k]}
          </span>
        ))}
      </div>
      <div className="min-w-[900px] px-4 pt-2 pb-5">
        <div className="grid grid-cols-[220px_minmax(0,1fr)]">
          <span />
          <div className="relative h-6">
            {ticks.map((tick, i) => (
              <span key={i} className="absolute bottom-1 -translate-x-1/2 font-mono text-[11px] text-muted-foreground" style={{ left: `${pct(tick)}%` }}>
                {new Date(tick).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: span < 600_000 ? "2-digit" : undefined })}
              </span>
            ))}
          </div>
        </div>
        <div className="relative">
          <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 left-[220px]">
            {ticks.map((tick, i) => (
              <span key={i} className="absolute inset-y-0 w-px bg-border" style={{ left: `${pct(tick)}%` }} />
            ))}
            {workflow.status?.phase === "Running" && <span className="absolute inset-y-0 w-0.5 bg-primary" style={{ left: `${pct(now)}%` }} />}
          </div>
          {rows.map((row) => (
            <div key={row.id} className={cn("relative grid h-11 grid-cols-[220px_minmax(0,1fr)] items-center border-b border-border/50", selectedId === row.id && "bg-primary/5")}>
              <button type="button" onClick={() => onSelect(row.id)} className="flex min-w-0 flex-col text-left">
                <span className="truncate font-mono text-xs font-medium hover:underline">{row.displayName}</span>
                <span className="text-[11px] text-muted-foreground">{row.type === "Retry" ? t("retried", { count: Math.max(0, (row.children?.length ?? 1) - 1) }) : row.type}</span>
              </button>
              <div className="relative h-11">
                {segmentsFor(row).map((s, i) => (
                  <button
                    type="button"
                    key={i}
                    title={s.title}
                    onClick={() => s.nodeId && onSelect(s.nodeId)}
                    className={cn("absolute top-3 flex h-5 items-center overflow-hidden rounded px-1.5 text-[11px] font-semibold whitespace-nowrap", style[s.kind])}
                    style={{ left: `${s.left}%`, width: `${s.width}%` }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
