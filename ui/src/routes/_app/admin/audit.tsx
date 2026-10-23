import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronRight, Download, Search } from "lucide-react";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";

import { listAudit } from "@/api/authz";
import type { AuditEvent } from "@/api/types";
import { AdminLayout } from "@/admin/layout";
import { EmptyState, ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/admin/audit")({ component: AuditPage });

const PAGE = 50;
const resultTone: Record<string, string> = {
  allowed: "bg-phase-ok-bg text-phase-ok",
  denied: "bg-phase-fail-bg text-phase-fail",
  recorded: "bg-phase-susp-bg text-phase-susp",
};

/** Every write and every refused request (Kubernetes only sees the platform ServiceAccount). */
function AuditPage() {
  const { t } = useTranslation();
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [result, setResult] = useState("all");
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string>();
  const query = useQuery({
    queryKey: ["authz", "audit", actor, action, result, offset],
    queryFn: () => listAudit({ actor: actor || undefined, action: action || undefined, result: result === "all" ? undefined : result, limit: PAGE, offset }),
    placeholderData: keepPreviousData,
  });
  const events = query.data?.events ?? [];
  const total = query.data?.total ?? 0;

  const exportCsv = () => {
    const rows = [["at", "actor", "action", "resourceType", "namespace", "name", "result", "reason", "revision"], ...events.map((e) => [e.at, e.actor, e.action, e.resourceType, e.namespace, e.name, e.result, e.reason ?? "", String(e.revision)])];
    const csv = rows.map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "argonaut-audit.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AdminLayout
      actions={
        <Button variant="outline" onClick={exportCsv} disabled={!events.length}>
          <Download aria-hidden />
          {t("Export CSV")}
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative w-full max-w-xs">
          <span className="sr-only">{t("Actor")}</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={actor} onChange={(e) => (setActor(e.target.value), setOffset(0))} placeholder={t("Actor")} className="bg-card pl-9" />
        </label>
        <Input value={action} onChange={(e) => (setAction(e.target.value), setOffset(0))} placeholder={t("Action, e.g. workflow:")} className="w-56 bg-card font-mono text-xs" aria-label={t("Action")} />
        <ToggleGroup type="single" variant="outline" size="sm" value={result} onValueChange={(v) => v && (setResult(v), setOffset(0))} className="ml-auto" aria-label={t("Result")}>
          {["all", "allowed", "denied", "recorded"].map((r) => (
            <ToggleGroupItem key={r} value={r} className="px-3">
              {t(r === "all" ? "All" : r)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {query.error ? (
        <ErrorState error={query.error} />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table className="min-w-[1000px]">
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="w-8" />
                  <TableHead>{t("When")}</TableHead>
                  <TableHead>{t("Actor")}</TableHead>
                  <TableHead>{t("Action")}</TableHead>
                  <TableHead>{t("Resource")}</TableHead>
                  <TableHead>{t("Result")}</TableHead>
                  <TableHead>{t("Revision")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((e) => (
                  <Row key={e.id} e={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? undefined : e.id)} />
                ))}
              </TableBody>
            </Table>
          </div>
          {!query.isPending && !events.length && <EmptyState title={t("No events")} />}
        </div>
      )}
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>{total ? t("{{from}}–{{to}} of {{total}}", { from: offset + 1, to: offset + events.length, total }) : ""}</span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            {t("Previous")}
          </Button>
          <Button variant="outline" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            {t("Next")}
          </Button>
        </div>
      </div>
    </AdminLayout>
  );
}

function Row({ e, open, onToggle }: { e: AuditEvent; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const resource = [e.namespace, e.name].filter(Boolean).join("/") || "*";
  let detail: Record<string, unknown> | undefined;
  try {
    detail = e.detail ? JSON.parse(e.detail) : undefined;
  } catch {
    detail = undefined;
  }
  return (
    <Fragment>
      <TableRow className={cn(open && "bg-muted/40")}>
        <TableCell>
          <Button variant="ghost" size="icon" className="size-7" aria-expanded={open} aria-label={t("Show details")} onClick={onToggle}>
            <ChevronRight className={cn("transition-transform", open && "rotate-90")} aria-hidden />
          </Button>
        </TableCell>
        <TableCell className="font-mono text-xs">{formatTimestamp(e.at)}</TableCell>
        <TableCell>{e.actor || <span className="text-muted-foreground">{t("outside argonaut")}</span>}</TableCell>
        <TableCell>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{e.action}</span>
        </TableCell>
        <TableCell className="max-w-80 truncate">
          {e.cluster && <span className="mr-1.5 rounded bg-muted px-1 text-[11px] text-muted-foreground">{e.cluster}</span>}
          <span className="text-xs text-muted-foreground">{e.resourceType} </span>
          <span className="font-mono text-xs">{resource}</span>
        </TableCell>
        <TableCell>
          <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", resultTone[e.result])}>{t(e.result)}</span>
        </TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground">{e.revision ? `r${e.revision}` : "—"}</TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/20 hover:bg-muted/20">
          <TableCell />
          <TableCell colSpan={6} className="space-y-2 py-3 whitespace-normal">
            {e.reason && (
              <p className="text-sm">
                <span className="text-muted-foreground">{t("Reason")}: </span>
                {e.reason}
              </p>
            )}
            {detail && <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs text-zinc-200">{JSON.stringify(detail, null, 2)}</pre>}
            <p className="text-xs text-muted-foreground">{t("Decided at authorization revision r{{rev}}.", { rev: e.revision ?? 0 })}</p>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}
