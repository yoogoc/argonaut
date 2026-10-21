import { formatDistanceToNowStrict } from "date-fns";
import { enUS, zhCN } from "date-fns/locale";

import i18n from "./i18n";

const locale = () => (i18n.language === "zh-CN" ? zhCN : enUS);

export function formatTimestamp(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(i18n.language);
}

/** "3 minutes ago" for recent times, the date for anything older than a week. */
export function formatRelative(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (Date.now() - date.getTime() > 7 * 24 * 3600 * 1000) return date.toLocaleDateString(i18n.language);
  return formatDistanceToNowStrict(date, { addSuffix: true, locale: locale() });
}

/** Human duration between two timestamps; an unfinished one measures against `now`. */
export function formatDuration(startedAt?: string | null, finishedAt?: string | null, now = Date.now()): string {
  if (!startedAt) return "—";
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "—";
  const end = finishedAt ? Date.parse(finishedAt) : now;
  return formatSeconds(Math.max(0, Math.round((end - start) / 1000)));
}

export function formatSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 48) return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function resourcesDuration(durations?: Record<string, number>): string {
  if (!durations) return "—";
  return (
    Object.entries(durations)
      .map(([resource, value]) => `${formatSeconds(value)}×${resource}`)
      .join(", ") || "—"
  );
}

/** "3/6" → [3, 6]. */
export function parseProgress(progress?: string): [number, number] | undefined {
  const m = progress?.match(/^(\d+)\/(\d+)$/);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2])];
}
