import { Ban, Check, CircleDashed, Clock, Loader2, Pause, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

type Tone = "ok" | "run" | "fail" | "pend" | "susp";

const toneClass: Record<Tone, string> = {
  ok: "bg-phase-ok-bg text-phase-ok",
  run: "bg-phase-run-bg text-phase-run",
  fail: "bg-phase-fail-bg text-phase-fail",
  pend: "bg-phase-pend-bg text-phase-pend",
  susp: "bg-phase-susp-bg text-phase-susp",
};

export const toneSolid: Record<Tone, string> = {
  ok: "bg-phase-ok-solid",
  run: "bg-phase-run-solid",
  fail: "bg-phase-fail-solid",
  pend: "bg-phase-pend-solid",
  susp: "bg-phase-susp-solid",
};

/** Maps an Argo phase onto one of the five visual tones the UI uses everywhere. */
export function phaseTone(phase?: string, suspended?: boolean): Tone {
  if (suspended) return "susp";
  switch (phase) {
    case "Succeeded":
      return "ok";
    case "Running":
      return "run";
    case "Failed":
    case "Error":
      return "fail";
    default:
      return "pend";
  }
}

const icons: Record<Tone, typeof Check> = { ok: Check, run: Loader2, fail: X, pend: Clock, susp: Pause };

/**
 * A run or node phase. The icon carries the meaning as much as the colour does, so the badge stays
 * readable for colour-blind users and in greyscale.
 */
export function PhaseBadge({ phase, suspended, className }: { phase?: string; suspended?: boolean; className?: string }) {
  const { t } = useTranslation();
  const tone = phaseTone(phase, suspended);
  let Icon = icons[tone];
  if (phase === "Skipped" || phase === "Omitted") Icon = Ban;
  if (!phase && !suspended) Icon = CircleDashed;
  const label = suspended ? t("Suspended") : phase ? t(phase) : t("Pending");
  return (
    <span className={cn("inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-semibold", toneClass[tone], className)}>
      <Icon className={cn("size-3", tone === "run" && "animate-spin [animation-duration:2s]")} strokeWidth={3} aria-hidden />
      {label}
    </span>
  );
}

/** A small status dot for graphs and dense lists. */
export function PhaseDot({ phase, className }: { phase?: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 rounded-full", toneSolid[phaseTone(phase)], className)} />;
}
