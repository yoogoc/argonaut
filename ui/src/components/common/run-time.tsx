import { ArrowLeftRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatRelative, formatTimestamp } from "@/lib/format";
import { usePreferences } from "@/stores/preferences";

/**
 * The start-time column header of the run lists. Clicking it switches every list between relative
 * ("3 minutes ago") and absolute times; the choice is remembered per browser.
 */
export function TimeDisplayToggle({ label }: { label: string }) {
  const { t } = useTranslation();
  const display = usePreferences((s) => s.timeDisplay);
  const setDisplay = usePreferences((s) => s.setTimeDisplay);
  const next = display === "relative" ? "absolute" : "relative";
  return (
    <button
      type="button"
      onClick={() => setDisplay(next)}
      title={next === "absolute" ? t("Show exact times") : t("Show relative times")}
      aria-label={`${label} · ${next === "absolute" ? t("Show exact times") : t("Show relative times")}`}
      className="group -mx-1 inline-flex items-center gap-1 rounded px-1 hover:bg-accent hover:text-foreground"
    >
      {label}
      <ArrowLeftRight className="size-3 opacity-40 group-hover:opacity-100" aria-hidden />
    </button>
  );
}

/** A run's start time in the chosen display, with the other form on hover. */
export function RunTime({ value }: { value?: string | null }) {
  const display = usePreferences((s) => s.timeDisplay);
  return display === "absolute" ? (
    <span className="whitespace-nowrap tabular-nums" title={formatRelative(value)}>
      {formatTimestamp(value)}
    </span>
  ) : (
    <span className="whitespace-nowrap" title={formatTimestamp(value)}>
      {formatRelative(value)}
    </span>
  );
}
