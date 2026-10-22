import { useTranslation } from "react-i18next";

import type { Parameter } from "@/api/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Rows stay one line tall: a couple of chips, the rest behind "+N".
const SHOWN = 2;

/** One line, whatever the value holds: JSON maps and scripts come with newlines and indentation. */
const oneLine = (v?: string) => (v ?? "").replace(/\s+/g, " ").trim();

/**
 * A run's parameters in a list row: the first two as name=value chips, every one of them (values in
 * full) on hover, where clicking one filters the list by it. The server sends the effective values:
 * template defaults under submitted ones.
 */
export function RunParams({ params, onFilter }: { params?: Parameter[]; onFilter?: (term: string) => void }) {
  const { t } = useTranslation();
  if (!params?.length) return <span className="text-muted-foreground">—</span>;
  const rest = params.length - SHOWN;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div tabIndex={0} aria-label={t("{{count}} parameters", { count: params.length })} className="flex max-w-[26rem] items-center gap-1 overflow-hidden outline-none">
          {params.slice(0, SHOWN).map((p) => (
            <span key={p.name} className="max-w-48 min-w-0 shrink truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              <span className="text-muted-foreground">{p.name}=</span>
              {oneLine(p.value) || <span className="text-muted-foreground">""</span>}
            </span>
          ))}
          {rest > 0 && <span className="shrink-0 rounded-md px-1 py-0.5 font-mono text-[11px] text-muted-foreground">+{rest}</span>}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-xl p-0">
        <dl className="grid max-h-80 grid-cols-[auto_1fr] gap-x-3 gap-y-1 overflow-auto p-3 font-mono text-[11px]">
          {params.map((p) =>
            onFilter ? (
              // A div is what a <dl> may group dt/dd in; it carries the button behaviour.
              <div
                key={p.name}
                role="button"
                tabIndex={0}
                onClick={() => onFilter(`${p.name}=${p.value ?? ""}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onFilter(`${p.name}=${p.value ?? ""}`);
                  }
                }}
                title={t("Filter by {{name}}={{value}}", { name: p.name, value: oneLine(p.value) })}
                className="col-span-2 grid cursor-pointer grid-cols-subgrid rounded hover:bg-white/10"
              >
                <dt className="opacity-70">{p.name}</dt>
                <dd className="break-all whitespace-pre-wrap">{p.value ?? ""}</dd>
              </div>
            ) : (
              <div key={p.name} className="contents">
                <dt className="opacity-70">{p.name}</dt>
                <dd className="break-all whitespace-pre-wrap">{p.value ?? ""}</dd>
              </div>
            ),
          )}
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}
