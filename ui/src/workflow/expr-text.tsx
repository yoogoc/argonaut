import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type ExpressionScope, hasTemplate, renderTemplate, type Segment, type ValueSource } from "@/lib/expressions";
import { cn } from "@/lib/utils";

/** What is known about the values of the node on screen (lib/expressions.ts); absent, values show as written. */
export const ExpressionContext = createContext<ExpressionScope | undefined>(undefined);

const SOURCE_NOTES: Record<ValueSource, string> = {
  pod: "From the template the controller rendered into the pod",
  run: "From what the run recorded",
  estimate: "Estimated from what the run recorded; the run may have used a different value",
};

/**
 * A highlighted variable that explains itself on hover (or focus): the variable as written, or the value
 * it rendered to, or why it could not be resolved. A short close delay lets the pointer move onto the card.
 */
function Variable({ className, detail, children }: { className: string; detail: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), 80);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), 120);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span
          tabIndex={0}
          onPointerEnter={show}
          onPointerLeave={hide}
          onFocus={show}
          onBlur={hide}
          className={cn("cursor-help rounded px-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
        >
          {children}
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="w-auto max-w-sm space-y-1 p-2 text-xs"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onPointerEnter={show}
        onPointerLeave={hide}
      >
        {detail}
      </PopoverContent>
    </Popover>
  );
}

function Detail({ label, value, note, source }: { label?: string; value?: string; note?: string; source?: ValueSource }) {
  const { t } = useTranslation();
  return (
    <>
      {label && <div className="text-muted-foreground">{label}</div>}
      {value !== undefined && <code className="block font-mono break-all whitespace-pre-wrap">{value}</code>}
      {note && <div className="text-muted-foreground">{note}</div>}
      {source && <div className={cn("border-t pt-1 text-muted-foreground", source === "estimate" && "text-phase-susp")}>{t(SOURCE_NOTES[source])}</div>}
    </>
  );
}

/**
 * The value with every template variable replaced by the value this run used, in bold green; hovering
 * shows the variable as written. A variable that cannot be resolved stays as written, in amber, with
 * the reason on hover. An estimated value is underlined, so it never passes for the one the run used.
 * "raw" shows the text as written with the variables highlighted.
 */
function Segments({ segments, mode, dark }: { segments: Segment[]; mode: "rendered" | "raw"; dark?: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      {segments.map((s, i) => {
        if ("text" in s) return <span key={i}>{s.text}</span>;
        if (s.value === undefined) {
          const reason = s.error
            ? t("Could not evaluate: {{error}}", { error: s.error })
            : s.path.startsWith("=")
              ? t("Expressions are evaluated by the controller and not shown here")
              : t("Not recorded in the run; cannot be resolved here");
          return (
            <Variable key={i} detail={<Detail note={reason} />} className={dark ? "bg-amber-400/15 text-amber-300" : "bg-phase-susp-bg text-phase-susp"}>
              {s.raw}
            </Variable>
          );
        }
        const value = s.value === "" ? '""' : s.value;
        if (mode === "raw") {
          return (
            <Variable key={i} detail={<Detail label={t("Rendered")} value={value} source={s.source} />} className={dark ? "bg-sky-400/10 text-sky-300" : "bg-primary/10 text-primary"}>
              {s.raw}
            </Variable>
          );
        }
        return (
          <Variable
            key={i}
            detail={<Detail label={t("As written")} value={s.raw} source={s.source} />}
            className={cn("font-semibold", s.source === "estimate" && "underline decoration-dashed underline-offset-2", dark ? "bg-emerald-400/15 text-emerald-300" : "bg-phase-ok-bg text-phase-ok")}
          >
            {value}
          </Variable>
        );
      })}
    </>
  );
}

/** A spec value; template variables show their rendered value, the original on hover (see Segments). */
export function ExprText({ text, className }: { text?: string; className?: string }) {
  const scope = useContext(ExpressionContext);
  if (text === undefined) return <>—</>;
  return (
    <span className={cn("font-mono text-xs leading-relaxed [overflow-wrap:anywhere]", className)}>
      {scope && hasTemplate(text) ? <Segments segments={renderTemplate(text, scope)} mode="rendered" /> : text}
    </span>
  );
}

/** A list of values (command, args), one per line. */
export function ExprList({ values }: { values?: string[] }) {
  if (!values?.length) return <>—</>;
  return (
    <span className="flex flex-col gap-1">
      {values.map((v, i) => (
        <ExprText key={i} text={v} />
      ))}
    </span>
  );
}

/** A multi-line value (script source, manifest, body): rendered, or as written. */
export function ExprCode({ text }: { text: string }) {
  const { t } = useTranslation();
  const scope = useContext(ExpressionContext);
  const templated = !!scope && hasTemplate(text);
  const [mode, setMode] = useState<"rendered" | "raw">("rendered");
  return (
    <div className="space-y-1">
      {templated && (
        <div role="group" aria-label={t("Show")} className="flex gap-1 text-[11px]">
          {(["rendered", "raw"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cn("rounded px-1.5 py-0.5", mode === m ? "bg-muted font-semibold" : "text-muted-foreground hover:bg-muted/60")}
            >
              {m === "rendered" ? t("Rendered") : t("As written")}
            </button>
          ))}
        </div>
      )}
      <pre className="max-h-80 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-zinc-200">
        {templated ? <Segments segments={renderTemplate(text, scope)} mode={mode} dark /> : text}
      </pre>
    </div>
  );
}
