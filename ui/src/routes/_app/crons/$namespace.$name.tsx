import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Pause, Pencil, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useActions } from "@/api/authz";
import { cronQueries, deleteCronWorkflow, lintCronWorkflow, resumeCronWorkflow, runCronWorkflowNow, suspendCronWorkflow, updateCronWorkflow } from "@/api/cronWorkflows";
import type { CronWorkflow, Workflow } from "@/api/types";
import { workflowQueries } from "@/api/workflows";
import { ConfirmAction } from "@/components/common/confirm-action";
import { ManifestDialog } from "@/components/common/manifest-dialog";
import { Mono, Page, PageHeader, Section } from "@/components/common/page";
import { PhaseBadge, phaseTone, toneSolid } from "@/components/common/phase-badge";
import { EmptyState, ErrorState, errorMessage, Spinner } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeCron } from "@/lib/cron";
import { formatDuration, formatRelative, formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toYaml } from "@/lib/yaml";


export const Route = createFileRoute("/_app/crons/$namespace/$name")({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(cronQueries.detail(params.namespace, params.name)),
  pendingComponent: () => <Spinner className="mt-20" />,
  errorComponent: ({ error }) => <ErrorState error={error} className="m-6" />,
  component: CronDetail,
});

function editable(cron: CronWorkflow) {
  return toYaml({ apiVersion: "argoproj.io/v1alpha1", kind: "CronWorkflow", metadata: { name: cron.metadata.name, namespace: cron.metadata.namespace, labels: cron.metadata.labels, annotations: cron.metadata.annotations, resourceVersion: cron.metadata.resourceVersion }, spec: cron.spec });
}

function CronDetail() {
  const { t, i18n } = useTranslation();
  const { namespace, name } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery(cronQueries.detail(namespace, name));
  const cron = query.data;
  const template = cron?.spec.workflowSpec.workflowTemplateRef;
  const { can } = useActions(cron ? { namespace, template: template && !template.clusterScope ? template.name : undefined } : undefined);
  const runs = useQuery(workflowQueries.list({ namespace, labelSelector: `workflows.argoproj.io/cron-workflow=${name}`, limit: 200 }));
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const act = useMutation({
    mutationFn: async (op: "suspend" | "resume" | "run" | "delete") => {
      if (op === "suspend") return suspendCronWorkflow(namespace, name);
      if (op === "resume") return resumeCronWorkflow(namespace, name);
      if (op === "run") return runCronWorkflowNow(namespace, name);
      await deleteCronWorkflow(namespace, name);
    },
    onSuccess: (result, op) => {
      void queryClient.invalidateQueries({ queryKey: ["crons"] });
      if (op === "delete") void navigate({ to: "/crons" });
      if (op === "run" && result) void navigate({ to: "/workflows/$namespace/$name", params: { namespace, name: (result as Workflow).metadata.name } });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!cron) return null;
  const schedules = cron.spec.schedules ?? (cron.spec.schedule ? [cron.spec.schedule] : []);
  const items = runs.data?.items ?? [];

  return (
    <Page>
      <PageHeader
        breadcrumb={
          <span className="flex gap-1.5">
            <Link to="/crons" className="hover:text-foreground">
              {t("CronWorkflows")}
            </Link>
            <span aria-hidden>/</span>
            <span className="font-mono">{namespace}</span>
          </span>
        }
        title={
          <>
            <span className="font-mono text-[22px] font-semibold">{name}</span>
            {cron.spec.suspend ? (
              <span className="rounded-full bg-phase-susp-bg px-2 py-0.5 text-xs font-semibold text-phase-susp">{t("Suspended")}</span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-phase-ok-bg px-2 py-0.5 text-xs font-semibold text-phase-ok">
                <span aria-hidden className="size-1.5 rounded-full bg-phase-ok-solid" />
                {t("Active")}
              </span>
            )}
          </>
        }
        actions={
          <>
            {cron.spec.suspend
              ? can("cron:resume") && (
                  <Button variant="outline" onClick={() => act.mutate("resume")} disabled={act.isPending}>
                    <Play aria-hidden />
                    {t("Resume schedule")}
                  </Button>
                )
              : can("cron:suspend") && (
                  <Button variant="outline" onClick={() => act.mutate("suspend")} disabled={act.isPending}>
                    <Pause aria-hidden />
                    {t("Suspend schedule")}
                  </Button>
                )}
            {can("cron:update") && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil aria-hidden />
                {t("Edit")}
              </Button>
            )}
            {can("cron:delete") && (
              <Button variant="outline" size="icon" className="text-destructive" aria-label={t("Delete CronWorkflow")} onClick={() => setConfirmDelete(true)}>
                <Trash2 aria-hidden />
              </Button>
            )}
            {can("cron:run") && (
              <Button onClick={() => act.mutate("run")} disabled={act.isPending}>
                <Play aria-hidden />
                {t("Run now")}
              </Button>
            )}
          </>
        }
      />

      <div className="grid overflow-hidden rounded-xl border bg-card sm:grid-cols-2 lg:grid-cols-5">
        <Stat label={t("Schedule")} value={<Mono>{schedules.join(", ") || "—"}</Mono>} sub={`${schedules.map((s) => describeCron(s, i18n.language)).join("; ")}${cron.spec.timezone ? ` · ${cron.spec.timezone}` : ""}`} />
        <Stat label={t("Next run")} value={cron.nextRuns[0] ? formatTimestamp(cron.nextRuns[0]) : "—"} sub={cron.spec.suspend ? t("Suspended") : cron.nextRuns[0] ? formatRelative(cron.nextRuns[0]) : ""} />
        <Stat label={t("Concurrency")} value={<Mono>{cron.spec.concurrencyPolicy ?? "Allow"}</Mono>} sub={{ Forbid: t("Skips a run while the previous one is still running"), Replace: t("Replaces a still-running run"), Allow: t("Runs may overlap") }[cron.spec.concurrencyPolicy ?? "Allow"]} />
        <Stat
          label={t("Template")}
          value={
            template ? (
              template.clusterScope ? (
                <Link to="/cluster-templates/$name" params={{ name: template.name }} className="font-mono text-primary hover:underline">
                  {template.name}
                </Link>
              ) : (
                <Link to="/templates/$namespace/$name" params={{ namespace, name: template.name }} className="font-mono text-primary hover:underline">
                  {template.name}
                </Link>
              )
            ) : (
              t("Inline spec")
            )
          }
          sub={template ? t("Permissions follow the template") : t("Permissions follow the namespace")}
        />
        <Stat label={t("History kept")} value={t("{{ok}} succeeded · {{failed}} failed", { ok: cron.spec.successfulJobsHistoryLimit ?? 3, failed: cron.spec.failedJobsHistoryLimit ?? 1 })} sub={t("Older runs are removed by the controller")} last />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t("Last 30 days")} bodyClassName="p-4">
          <RunGrid runs={items} />
        </Section>
        <Section title={t("Upcoming runs")} description={cron.spec.timezone}>
          <ol className="divide-y px-4">
            {cron.nextRuns.map((r) => (
              <li key={r} className="flex justify-between py-2 text-[13px]">
                <span className="font-mono">{formatTimestamp(r)}</span>
                <span className="text-muted-foreground">{formatRelative(r)}</span>
              </li>
            ))}
            {!cron.nextRuns.length && <li className="py-3 text-sm text-muted-foreground">{t("No upcoming runs")}</li>}
          </ol>
        </Section>
      </div>

      <Section title={t("Run history")}>
        {items.length === 0 ? (
          <EmptyState title={t("No runs yet")} />
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[680px]">
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>{t("Scheduled")}</TableHead>
                  <TableHead>{t("Trigger")}</TableHead>
                  <TableHead>{t("Status")}</TableHead>
                  <TableHead>{t("Workflow")}</TableHead>
                  <TableHead>{t("Duration")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.slice(0, 30).map((wf) => {
                  const manual = !!wf.metadata.labels?.["workflows.argoproj.io/creator"];
                  return (
                    <TableRow key={wf.metadata.uid ?? wf.metadata.name}>
                      <TableCell className="font-mono text-xs">{formatTimestamp(wf.metadata.annotations?.["workflows.argoproj.io/scheduled-time"] ?? wf.metadata.creationTimestamp)}</TableCell>
                      <TableCell>{manual ? t("Run now by {{who}}", { who: wf.metadata.labels!["workflows.argoproj.io/creator"] }) : t("Schedule")}</TableCell>
                      <TableCell>
                        <PhaseBadge phase={wf.status?.phase} />
                      </TableCell>
                      <TableCell>
                        <Link to="/workflows/$namespace/$name" params={{ namespace, name: wf.metadata.name }} className="font-mono text-xs text-primary hover:underline">
                          {wf.metadata.name}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{formatDuration(wf.status?.startedAt, wf.status?.finishedAt)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <ManifestDialog
        open={editing}
        onOpenChange={setEditing}
        title={t("Edit {{name}}", { name })}
        initial={editable(cron)}
        path={`cron-${namespace}-${name}.yaml`}
        onLint={(m) => lintCronWorkflow(namespace, m)}
        onSave={async (m) => {
          await updateCronWorkflow(namespace, name, m);
          void queryClient.invalidateQueries({ queryKey: ["crons"] });
          toast.success(t("Saved"));
        }}
        saveLabel={t("Save")}
      />
      <ConfirmAction open={confirmDelete} onOpenChange={setConfirmDelete} title={t("Delete {{name}}?", { name })} description={t("The schedule stops; runs it already created are kept.")} confirmLabel={t("Delete")} typeToConfirm={name} onConfirm={() => act.mutate("delete")} />
    </Page>
  );
}

function Stat({ label, value, sub, last }: { label: string; value: React.ReactNode; sub?: string; last?: boolean }) {
  return (
    <div className={cn("flex flex-col gap-1.5 border-b p-4 lg:border-b-0", !last && "lg:border-r")}>
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <span className="text-[17px] font-semibold">{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

/** One square per day for the last 30 days, coloured by the worst outcome that day. */
function RunGrid({ runs }: { runs: Workflow[] }) {
  const { t } = useTranslation();
  const days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (29 - i));
    return d;
  });
  const byDay = days.map((d) => {
    const next = new Date(d);
    next.setDate(d.getDate() + 1);
    const dayRuns = runs.filter((r) => {
      const at = Date.parse(r.metadata.creationTimestamp ?? "");
      return at >= d.getTime() && at < next.getTime();
    });
    const phase = dayRuns.some((r) => phaseTone(r.status?.phase) === "fail") ? "Failed" : dayRuns.some((r) => r.status?.phase === "Running") ? "Running" : dayRuns.length ? "Succeeded" : undefined;
    return { d, phase, count: dayRuns.length };
  });
  return (
    <div className="space-y-2">
      <div role="img" aria-label={t("Runs per day over the last 30 days")} className="grid grid-cols-15 gap-1.5" style={{ gridTemplateColumns: "repeat(15, minmax(0, 1fr))" }}>
        {byDay.map(({ d, phase, count }) => (
          <span key={d.toISOString()} title={`${d.toLocaleDateString()} · ${count}`} className={cn("aspect-square rounded", phase ? toneSolid[phaseTone(phase)] : "border border-dashed border-border bg-transparent")} />
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{days[0].toLocaleDateString()}</span>
        <span>{t("Today")}</span>
      </div>
    </div>
  );
}
