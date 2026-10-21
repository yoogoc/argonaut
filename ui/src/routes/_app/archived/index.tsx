import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { archiveQueries } from "@/api/archive";
import { Page, PageHeader } from "@/components/common/page";
import { PhaseBadge } from "@/components/common/phase-badge";
import { EmptyState, ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useNamespace } from "@/hooks/use-namespace";
import { formatDuration, formatTimestamp } from "@/lib/format";
import { sourceTemplate } from "@/lib/workflow";
import { useSession } from "@/stores/session";

const PAGE_SIZE = 50;
const PHASES = ["Succeeded", "Failed", "Error"] as const;

const searchSchema = z.object({
  prefix: z.string().optional(),
  phases: z.array(z.string()).optional(),
  labels: z.string().optional(),
  // Tokens of the pages before this one, so Previous works on an offset-less archive cursor.
  pages: z.array(z.string()).optional(),
});

export const Route = createFileRoute("/_app/archived/")({
  validateSearch: searchSchema,
  component: ArchiveListPage,
});

/** Archived runs (DESIGN §2.4): finished workflows the controller moved out of the cluster. */
function ArchiveListPage() {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { namespace } = useNamespace();
  const enabled = useSession((s) => !!s.info?.archiveEnabled);
  const [prefix, setPrefix] = useState(search.prefix ?? "");
  const [labels, setLabels] = useState(search.labels ?? "");
  const pages = search.pages ?? [];
  const query = useQuery({
    ...archiveQueries.list({
      namespace,
      namePrefix: search.prefix || undefined,
      labelSelector: search.labels || undefined,
      phases: search.phases?.length ? search.phases : undefined,
      limit: PAGE_SIZE,
      continueToken: pages[pages.length - 1],
    }),
    enabled,
  });
  const setSearch = (patch: Partial<z.infer<typeof searchSchema>>) => void navigate({ search: (prev) => ({ ...prev, pages: undefined, ...patch }), replace: true });
  const items = query.data?.items ?? [];
  const next = query.data?.metadata?.continue;

  return (
    <Page>
      <PageHeader
        title={t("Archive")}
        description={t("Finished runs the controller archived to its database after removing them from the cluster. Permissions follow each run's template, as for live runs.")}
      />
      {!enabled ? (
        <EmptyState title={t("The workflow archive is not enabled")} description={t("Set persistence.archive in the Argo controller ConfigMap to keep finished runs after they are removed from the cluster.")} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <form
              className="relative w-full max-w-xs"
              onSubmit={(e) => {
                e.preventDefault();
                setSearch({ prefix: prefix || undefined });
              }}
            >
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} onBlur={() => setSearch({ prefix: prefix || undefined })} placeholder={t("Name prefix")} aria-label={t("Name prefix")} className="bg-card pl-9" />
            </form>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSearch({ labels: labels || undefined });
              }}
            >
              <Input value={labels} onChange={(e) => setLabels(e.target.value)} onBlur={() => setSearch({ labels: labels || undefined })} placeholder={t("Labels, e.g. team=data")} aria-label={t("Label selector")} className="w-56 bg-card font-mono text-xs" />
            </form>
            <ToggleGroup type="multiple" variant="outline" size="sm" value={search.phases ?? []} onValueChange={(v) => setSearch({ phases: v.length ? v : undefined })} aria-label={t("Filter by phase")}>
              {PHASES.map((p) => (
                <ToggleGroupItem key={p} value={p} className="px-3">
                  {t(p)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          {query.error ? (
            <ErrorState error={query.error} />
          ) : query.isPending ? (
            <Skeleton className="h-64 w-full" />
          ) : items.length === 0 ? (
            <EmptyState title={t("No archived runs")} description={search.prefix || search.labels || search.phases ? t("Nothing matches these filters.") : t("Archived runs you may see in this namespace will appear here.")} />
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>{t("Name")}</TableHead>
                    <TableHead>{t("Phase")}</TableHead>
                    <TableHead>{t("Template")}</TableHead>
                    <TableHead>{t("Started")}</TableHead>
                    <TableHead>{t("Duration")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((wf) => (
                    <TableRow key={wf.metadata.uid}>
                      <TableCell>
                        <Link to="/archived/$uid" params={{ uid: wf.metadata.uid! }} className="font-mono text-[13px] font-medium text-primary hover:underline">
                          {wf.metadata.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <PhaseBadge phase={wf.status?.phase} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{sourceTemplate(wf) ?? "—"}</TableCell>
                      <TableCell className="text-[13px]">{formatTimestamp(wf.status?.startedAt)}</TableCell>
                      <TableCell className="font-mono text-xs">{formatDuration(wf.status?.startedAt, wf.status?.finishedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex items-center justify-end gap-2 border-t px-4 py-2 text-[13px] text-muted-foreground">
                <Button variant="outline" size="sm" disabled={!pages.length} onClick={() => void navigate({ search: (prev) => ({ ...prev, pages: pages.slice(0, -1) }), replace: true })}>
                  {t("Previous")}
                </Button>
                <Button variant="outline" size="sm" disabled={!next} onClick={() => next && void navigate({ search: (prev) => ({ ...prev, pages: [...pages, next] }), replace: true })}>
                  {t("Next")}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
