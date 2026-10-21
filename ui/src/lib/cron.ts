import cronstrue from "cronstrue/i18n";

/** A cron expression in words, in the UI language. The schedule itself is computed by the server. */
export function describeCron(expr: string, lang: string): string {
  try {
    return cronstrue.toString(expr, { locale: lang === "zh-CN" ? "zh_CN" : "en", use24HourTimeFormat: true });
  } catch {
    return expr;
  }
}
