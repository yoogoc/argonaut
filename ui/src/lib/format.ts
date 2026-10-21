import { formatDistanceToNowStrict } from "date-fns";

import type { NodePhase } from "@/api/types";

export function formatTimestamp(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatRelative(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${formatDistanceToNowStrict(date)} ago`;
}

/** Human duration between two timestamps; an unfinished workflow measures against now. */
export function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return "-";
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "-";
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  return formatSeconds(Math.max(0, Math.round((end - start) / 1000)));
}

export function formatSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

/** Colour per phase, kept in one place so the graph, badges and lists cannot drift apart. */
export const phaseColor: Record<NodePhase | "Unknown", string> = {
  Pending: "#a8a29e",
  Running: "#0ea5e9",
  Succeeded: "#16a34a",
  Failed: "#dc2626",
  Error: "#b91c1c",
  Omitted: "#a1a1aa",
  Skipped: "#a1a1aa",
  Unknown: "#a1a1aa",
};

export const phaseTextClass: Record<string, string> = {
  Pending: "text-stone-600 dark:text-stone-300",
  Running: "text-sky-600 dark:text-sky-400",
  Succeeded: "text-green-700 dark:text-green-400",
  Failed: "text-red-600 dark:text-red-400",
  Error: "text-red-700 dark:text-red-400",
  Omitted: "text-zinc-500",
  Skipped: "text-zinc-500",
};

export function resourcesDuration(durations?: Record<string, number>): string {
  if (!durations) return "-";
  return (
    Object.entries(durations)
      .map(([resource, value]) => `${value}s*${resource}`)
      .join(", ") || "-"
  );
}
