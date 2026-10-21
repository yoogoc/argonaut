import { AlertTriangle, Check, GitMerge } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { stringify } from "yaml";

import { MODIFIED_BY_ANNOTATION } from "@/api/templates";
import { YamlEditor } from "@/components/common/yaml-editor";
import { Button } from "@/components/ui/button";
import { SpecGraphView } from "@/graph/spec-view";
import { parseYaml } from "@/lib/yaml";
import { cn } from "@/lib/utils";

import { getIn, type Json } from "./doc";
import { type Conflict, merge3, type Path, resolveAt } from "./merge";
import { specOf } from "./store";

type Choice = { by: "theirs" | "mine" | "manual"; value: unknown };

const show = (v: unknown) => (v === undefined ? "# (not set)\n" : stringify(v, { lineWidth: 0 }));
const startsWith = (path: Path, prefix: Path) => prefix.length <= path.length && prefix.every((p, i) => p === path[i]);

/**
 * The save-conflict view (DESIGN §3.5): someone saved the template while it was being edited. Both
 * sides are merged structurally against the version the editor loaded; changes that do not overlap
 * merge on their own, and each overlapping one is decided here before the merged result is saved
 * against their resourceVersion.
 */
export function ConflictView({ base, theirs, mine, saving, onSave, onCancel }: { base: Json; theirs: Json; mine: Json; saving: boolean; onSave: (merged: Json) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const result = useMemo(() => merge3(base, theirs, mine), [base, theirs, mine]);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [selected, setSelected] = useState(0);
  const [draft, setDraft] = useState<{ index: number; text: string; error?: string }>();

  const merged = useMemo(() => {
    let out = result.merged;
    for (const [i, c] of Object.entries(choices)) out = resolveAt(out, result.conflicts[Number(i)].path, c.value);
    return out as Json;
  }, [result, choices]);
  const open = result.conflicts.length - Object.keys(choices).length;
  const conflict: Conflict | undefined = result.conflicts[selected];

  // Mark tasks of the entry DAG whose definition (or the template they run) was touched.
  const spec = specOf(merged);
  const entryIndex = (spec.templates ?? []).findIndex((x) => x.name === spec.entrypoint);
  const entry = spec.templates?.[entryIndex];
  const prefixes = (task: string): Path[] => {
    const i = entry?.dag?.tasks?.findIndex((x) => x.name === task) ?? -1;
    const out: Path[] = i >= 0 ? [["spec", "templates", entryIndex, "dag", "tasks", i]] : [];
    const runs = entry?.dag?.tasks?.[i]?.template;
    const ti = (spec.templates ?? []).findIndex((x) => x.name === runs);
    if (ti >= 0) out.push(["spec", "templates", ti]);
    return out;
  };
  const badge = (task: string) => {
    const ps = prefixes(task);
    const hit = (path: Path) => ps.some((p) => startsWith(path, p));
    if (result.conflicts.some((c, i) => hit(c.path) && !choices[i])) return { label: t("conflict"), tone: "conflict" as const };
    const who = new Set(result.changes.filter((c) => hit(c.path)).map((c) => c.who));
    if (who.has("mine") && who.has("theirs")) return { label: t("both"), tone: "mine" as const };
    if (who.has("mine")) return { label: t("mine"), tone: "mine" as const };
    if (who.has("theirs")) return { label: t("theirs"), tone: "theirs" as const };
    return undefined;
  };

  const choose = (index: number, choice: Choice) => {
    setChoices((c) => ({ ...c, [index]: choice }));
    setDraft(undefined);
    const next = result.conflicts.findIndex((_, i) => i !== index && !choices[i]);
    if (next >= 0) setSelected(next);
  };

  const theirRv = String(getIn(theirs, ["metadata", "resourceVersion"]) ?? "");
  const baseRv = String(getIn(base, ["metadata", "resourceVersion"]) ?? "");
  const by = getIn(theirs, ["metadata", "annotations", MODIFIED_BY_ANNOTATION]) as string | undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="alert" className="flex flex-wrap items-center gap-3 border-b bg-diff-conflict-bg px-4 py-2.5 text-sm">
        <AlertTriangle className="size-4 shrink-0 text-diff-conflict" aria-hidden />
        <p className="min-w-0 flex-1">
          <strong>{t("Someone saved this template while you were editing.")}</strong>{" "}
          <span className="text-muted-foreground">
            {t("Your edits started from version {{base}}; the latest is {{theirs}}.", { base: baseRv || "—", theirs: theirRv })}{" "}
            {by && t("Last saved through argonaut by {{who}}.", { who: by })}{" "}
            {result.conflicts.length ? t("{{n}} change(s) overlap and need a decision.", { n: result.conflicts.length }) : t("None of the changes overlap.")}
          </span>
        </p>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t("Back to my edits")}
        </Button>
        <Button size="sm" disabled={open > 0 || saving} onClick={() => onSave(merged)}>
          <GitMerge aria-hidden />
          {open > 0 ? t("{{n}} left to resolve", { n: open }) : saving ? t("Saving…") : t("Lint and save merged")}
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_minmax(0,1.3fr)]">
        <aside aria-label={t("Changes")} className="flex min-h-0 flex-col overflow-auto border-r">
          <h2 className="px-4 pt-3 pb-1.5 text-xs font-semibold text-muted-foreground">{t("Overlapping changes")}</h2>
          {result.conflicts.length === 0 && <p className="px-4 text-xs text-muted-foreground">{t("None")}</p>}
          {result.conflicts.map((c, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                setSelected(i);
                setDraft(undefined);
              }}
              className={cn("flex items-center gap-2 border-l-2 px-4 py-2 text-left text-[13px] hover:bg-accent", i === selected ? "border-diff-conflict bg-accent" : "border-transparent")}
            >
              {choices[i] ? <Check className="size-3.5 shrink-0 text-phase-ok" aria-label={t("Resolved")} /> : <span aria-label={t("Unresolved")} className="size-2 shrink-0 rounded-full bg-diff-conflict" />}
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{c.label}</span>
              {choices[i] && <span className="text-[11px] text-muted-foreground">{t(choices[i].by)}</span>}
            </button>
          ))}
          <h2 className="px-4 pt-4 pb-1.5 text-xs font-semibold text-muted-foreground">{t("Merged automatically")}</h2>
          {result.changes.length === 0 && <p className="px-4 pb-3 text-xs text-muted-foreground">{t("None")}</p>}
          <ul className="pb-3">
            {result.changes.map((c, i) => (
              <li key={i} className="flex items-center gap-2 px-4 py-1 text-[13px]">
                <span className={cn("rounded px-1.5 text-[10px] font-bold text-white", c.who === "mine" ? "bg-diff-mine" : "bg-diff-theirs")}>{t(c.who)}</span>
                <span className="min-w-0 truncate font-mono text-xs">{c.label}</span>
              </li>
            ))}
          </ul>
        </aside>

        <section aria-label={t("Merged graph")} className="relative min-h-72 border-r bg-canvas">
          <SpecGraphView spec={spec} badge={badge} />
        </section>

        <section aria-label={t("Resolve")} className="flex min-h-0 flex-col overflow-auto">
          {conflict ? (
            <>
              <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
                <h2 className="min-w-0 flex-1 truncate font-mono text-sm font-semibold">{conflict.label}</h2>
                <Button size="sm" variant={choices[selected]?.by === "theirs" ? "default" : "outline"} onClick={() => choose(selected, { by: "theirs", value: conflict.theirs })}>
                  {t("Use theirs")}
                </Button>
                <Button size="sm" variant={choices[selected]?.by === "mine" ? "default" : "outline"} onClick={() => choose(selected, { by: "mine", value: conflict.mine })}>
                  {t("Use mine")}
                </Button>
                <Button size="sm" variant={choices[selected]?.by === "manual" ? "default" : "outline"} onClick={() => setDraft({ index: selected, text: show(choices[selected]?.value ?? conflict.mine) })}>
                  {t("Edit")}
                </Button>
              </header>
              <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-4 xl:grid-cols-3">
                {(
                  [
                    ["Base", conflict.base, "border-border"],
                    ["Theirs", conflict.theirs, "border-diff-theirs"],
                    ["Mine", conflict.mine, "border-diff-mine"],
                  ] as const
                ).map(([title, value, border]) => (
                  <div key={title} className="flex min-h-40 flex-col gap-1.5">
                    <h3 className="text-xs font-semibold text-muted-foreground">{t(title)}</h3>
                    <YamlEditor value={show(value)} readOnly className={cn("min-h-40 flex-1 border-2", border)} path={`conflict-${selected}-${title}`} />
                  </div>
                ))}
              </div>
              {draft?.index === selected && (
                <div className="flex flex-col gap-2 border-t p-4">
                  <h3 className="text-xs font-semibold text-muted-foreground">{t("Result")}</h3>
                  <YamlEditor value={draft.text} onChange={(text) => setDraft({ ...draft, text, error: parseYaml(text).error })} className="h-48" path={`conflict-${selected}-result`} />
                  {draft.error && <p className="text-xs text-destructive">{draft.error}</p>}
                  <div className="flex justify-end">
                    <Button size="sm" disabled={!!draft.error} onClick={() => choose(selected, { by: "manual", value: parseYaml(draft.text).value ?? undefined })}>
                      {t("Use this")}
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
              <Check className="size-6 text-phase-ok" aria-hidden />
              <p>{t("Every change merged on its own. Review the graph, then save.")}</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
