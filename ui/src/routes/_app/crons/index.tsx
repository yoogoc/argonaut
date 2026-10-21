import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus, Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useActions } from "@/api/authz";
import { createCronWorkflow, cronQueries, lintCronWorkflow } from "@/api/cronWorkflows";
import { ManifestDialog } from "@/components/common/manifest-dialog";
import { Page, PageHeader } from "@/components/common/page";
import { EmptyState, ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useNamespace } from "@/hooks/use-namespace";
import { describeCron } from "@/lib/cron";
import { formatRelative } from "@/lib/format";

export const Route = createFileRoute("/_app/crons/")({ component: CronList });

const EXAMPLE = (ns: string) => `apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: nightly
  namespace: ${ns}
spec:
  schedules: ["0 2 * * *"]
  timezone: Asia/Shanghai
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  workflowSpec:
    workflowTemplateRef:
      name: my-template
`;

function CronList() {
  const { t, i18n } = useTranslation();
  const { namespace } = useNamespace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const query = useQuery(cronQueries.list({ namespace, namePattern: q || undefined }));
  const { can } = useActions({ namespace });
  const items = query.data?.items ?? [];
  return (
    <Page>
      <PageHeader
        title={t("CronWorkflows")}
        description={t("Scheduled runs. A cron that references a template inherits that template's permissions.")}
        actions={
          can("cron:create") && (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t("New CronWorkflow")}
            </Button>
          )
        }
      />
      <label className="relative max-w-sm">
        <span className="sr-only">{t("Search by name")}</span>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search by name")} className="bg-card pl-9" />
      </label>
      {query.error ? (
        <ErrorState error={query.error} />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table className="min-w-[860px]">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>{t("Name")}</TableHead>
                  <TableHead>{t("Schedule")}</TableHead>
                  <TableHead>{t("Template")}</TableHead>
                  <TableHead>{t("State")}</TableHead>
                  <TableHead>{t("Last run")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.isPending &&
                  Array.from({ length: 4 }, (_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={5}>
                        <Skeleton className="h-5" />
                      </TableCell>
                    </TableRow>
                  ))}
                {items.map((c) => {
                  const schedules = c.spec.schedules ?? (c.spec.schedule ? [c.spec.schedule] : []);
                  return (
                    <TableRow key={c.metadata.uid ?? c.metadata.name}>
                      <TableCell>
                        <Link to="/crons/$namespace/$name" params={{ namespace: c.metadata.namespace, name: c.metadata.name }} className="font-mono text-[13px] font-medium text-primary hover:underline">
                          {c.metadata.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-mono text-xs">{schedules.join(", ")}</span>
                          <span className="text-xs text-muted-foreground">
                            {schedules.map((s) => describeCron(s, i18n.language)).join("; ")}
                            {c.spec.timezone ? ` · ${c.spec.timezone}` : ""}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{c.spec.workflowSpec.workflowTemplateRef?.name ?? "—"}</TableCell>
                      <TableCell>
                        {c.spec.suspend ? (
                          <span className="rounded-full bg-phase-susp-bg px-2 py-0.5 text-xs font-semibold text-phase-susp">{t("Suspended")}</span>
                        ) : (
                          <span className="rounded-full bg-phase-ok-bg px-2 py-0.5 text-xs font-semibold text-phase-ok">{t("Active")}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatRelative(c.status?.lastScheduledTime)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {!query.isPending && items.length === 0 && <EmptyState title={t("No CronWorkflows")} />}
        </div>
      )}
      <ManifestDialog
        open={creating}
        onOpenChange={setCreating}
        title={t("New CronWorkflow")}
        initial={EXAMPLE(namespace)}
        path="new-cron.yaml"
        onLint={(m) => lintCronWorkflow(namespace, m)}
        onSave={async (m) => {
          const created = await createCronWorkflow(namespace, m);
          void queryClient.invalidateQueries({ queryKey: ["crons"] });
          void navigate({ to: "/crons/$namespace/$name", params: { namespace: created.metadata.namespace, name: created.metadata.name } });
        }}
        saveLabel={t("Create")}
      />
    </Page>
  );
}
