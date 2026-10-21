import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { rollbackTemplate, type TemplateRef, templateQueries } from "@/api/templates";
import type { WorkflowTemplate } from "@/api/types";
import { ConfirmAction } from "@/components/common/confirm-action";
import { Mono } from "@/components/common/page";
import { EmptyState, ErrorState, errorMessage, Spinner } from "@/components/common/states";
import { YamlDiff } from "@/components/common/yaml-editor";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toYaml } from "@/lib/yaml";

import { semanticDiff } from "./semantic-diff";

/** Template history (DESIGN §3.6): pick two revisions, read the summary and the diff, roll back. */
export function Revisions({ templateRef, current, canRollback }: { templateRef: TemplateRef; current: WorkflowTemplate; canRollback: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const list = useQuery(templateQueries.revisions(templateRef));
  const revisions = useMemo(() => list.data ?? [], [list.data]);
  const [pair, setPair] = useState<[string, string]>();
  const [side, setSide] = useState<"unified" | "split">("unified");
  const [confirm, setConfirm] = useState(false);
  const selected = pair ?? (revisions.length >= 2 ? [revisions[1].id, revisions[0].id] : revisions.length === 1 ? [revisions[0].id, revisions[0].id] : undefined);
  const from = useQuery({ ...templateQueries.revision(templateRef, selected?.[0] ?? ""), enabled: !!selected });
  const to = useQuery({ ...templateQueries.revision(templateRef, selected?.[1] ?? ""), enabled: !!selected });
  const fromRev = revisions.find((r) => r.id === selected?.[0]);
  const toRev = revisions.find((r) => r.id === selected?.[1]);

  const changes = useMemo(() => (from.data?.manifest && to.data?.manifest ? semanticDiff(JSON.parse(from.data.manifest), JSON.parse(to.data.manifest)) : []), [from.data, to.data]);

  const rollback = useMutation({
    mutationFn: () => rollbackTemplate(templateRef, selected![0], current.metadata.resourceVersion ?? ""),
    onSuccess: () => {
      toast.success(t("Rolled back to #{{seq}}", { seq: fromRev?.seq }));
      void queryClient.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (list.isPending) return <Spinner />;
  if (list.error) return <ErrorState error={list.error} className="m-4" />;
  if (!revisions.length) return <EmptyState title={t("No revisions recorded yet")} />;

  // Clicking a revision compares it with the one before it; shift-click picks the "from" side.
  const choose = (id: string, from: boolean) => {
    const index = revisions.findIndex((r) => r.id === id);
    if (from && selected) setPair([id, selected[1]]);
    else setPair([revisions[index + 1]?.id ?? id, id]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <aside aria-label={t("Revisions")} className="border-b bg-card lg:w-80 lg:shrink-0 lg:border-r lg:border-b-0">
        <p className="border-b px-4 py-3 text-xs text-muted-foreground">{t("Recorded on every save through argonaut, and whenever a change made elsewhere is noticed. Shift-click to choose the older side.")}</p>
        <ul className="max-h-[60vh] overflow-auto lg:max-h-none">
          {revisions.map((r, i) => {
            const active = selected?.includes(r.id);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={(e) => choose(r.id, e.shiftKey)}
                  className={cn("flex w-full gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-accent", active && "bg-primary/5 shadow-[inset_3px_0_0_var(--primary)]")}
                >
                  <span className="w-8 shrink-0 font-mono text-[13px] font-semibold text-muted-foreground">#{r.seq}</span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-[13px] font-medium">{r.message || (r.external ? t("Changed outside argonaut") : t("Saved"))}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {r.external && <span className="rounded-full bg-phase-susp-bg px-1.5 font-semibold text-phase-susp">{t("External")}</span>}
                      {i === 0 && <span className="rounded-full bg-phase-ok-bg px-1.5 font-semibold text-phase-ok">{t("Current")}</span>}
                      {r.author || (r.external ? t("unknown author") : "")} · {formatTimestamp(r.createdAt)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-bold">
            {t("Compare")} <Mono>#{fromRev?.seq}</Mono> → <Mono>#{toRev?.seq}</Mono>
          </h2>
          <div className="ml-auto flex gap-2">
            <ToggleGroup type="single" variant="outline" size="sm" value={side} onValueChange={(v) => v && setSide(v as "unified" | "split")}>
              <ToggleGroupItem value="unified" className="px-3">
                {t("Unified")}
              </ToggleGroupItem>
              <ToggleGroupItem value="split" className="px-3">
                {t("Side by side")}
              </ToggleGroupItem>
            </ToggleGroup>
            {canRollback && fromRev && fromRev.id !== revisions[0].id && (
              <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
                <RotateCcw aria-hidden />
                {t("Roll back to #{{seq}}", { seq: fromRev.seq })}
              </Button>
            )}
          </div>
        </div>
        <section className="space-y-2 rounded-xl border bg-card p-4">
          <h3 className="text-sm font-bold">{t("Summary of changes")}</h3>
          {changes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{fromRev?.id === toRev?.id ? t("Same revision.") : t("No differences in the spec.")}</p>
          ) : (
            <ul className="space-y-1.5 text-[13px]">
              {changes.map((c, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <span className={cn("rounded-md px-1.5 text-xs font-semibold", c.kind === "added" ? "bg-phase-ok-bg text-phase-ok" : c.kind === "removed" ? "bg-phase-fail-bg text-phase-fail" : "bg-phase-run-bg text-phase-run")}>{t(c.kind)}</span>
                  <Mono>{c.subject}</Mono>
                  {c.fields?.length ? <span className="text-muted-foreground">{c.fields.join(", ")}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
        {from.data?.manifest && to.data?.manifest ? (
          <YamlDiff original={toYaml(JSON.parse(from.data.manifest))} modified={toYaml(JSON.parse(to.data.manifest))} sideBySide={side === "split"} className="min-h-[480px] flex-1 bg-card" />
        ) : (
          <Spinner />
        )}
      </div>
      <ConfirmAction
        open={confirm}
        onOpenChange={setConfirm}
        destructive={false}
        title={t("Roll back to #{{seq}}?", { seq: fromRev?.seq })}
        description={t("The spec of #{{seq}} is saved as a new revision. Runs already started are not affected.", { seq: fromRev?.seq })}
        confirmLabel={t("Roll back")}
        onConfirm={() => rollback.mutate()}
      />
    </div>
  );
}
