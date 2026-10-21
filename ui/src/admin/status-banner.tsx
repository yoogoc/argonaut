import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getAuthzStatus } from "@/api/authz";
import { formatRelative } from "@/lib/format";

/**
 * Shows that authorization data is consistent (DESIGN §4.3): the committed revision and whether every
 * live replica has loaded it.
 */
export function StatusBanner() {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: ["authz", "status"], queryFn: getAuthzStatus, refetchInterval: 10_000 });
  const s = query.data;
  if (!s) return null;
  const replicas = s.replicas ?? [];
  // Revision 0 (nothing granted yet) is omitted on the wire.
  const behind = replicas.filter((r) => (r.revision ?? 0) < (s.revision ?? 0));
  const ok = behind.length === 0;
  const last = s.lastChange;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card px-4 py-3 text-sm">
      <span className="flex items-center gap-2 font-semibold">
        {ok ? <ShieldCheck className="size-4 text-phase-ok" aria-hidden /> : <ShieldAlert className="size-4 text-phase-susp" aria-hidden />}
        {t("Authorization revision")} <span className="font-mono">r{s.revision ?? 0}</span>
      </span>
      <span className="text-muted-foreground">
        {ok ? t("All {{count}} replicas have loaded it", { count: replicas.length }) : t("{{behind}} of {{count}} replicas are catching up", { behind: behind.length, count: replicas.length })}
      </span>
      {last && (
        <span className="text-muted-foreground">
          {t("Last change")}: {last.actor} · {last.reason} · {formatRelative(last.at)}
        </span>
      )}
      <Link to="/admin/audit" className="ml-auto text-[13px] text-primary hover:underline">
        {t("Audit log")}
      </Link>
    </div>
  );
}
