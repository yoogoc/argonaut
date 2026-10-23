import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FileCode2, Plus, RotateCcw, Search, Square, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";

import type { List, Workflow } from "@/api/types";
import {
  deleteWorkflow,
  resubmitWorkflow,
  retryWorkflow,
  stopWorkflow,
  terminateWorkflow,
  watchWorkflows,
  workflowQueries,
} from "@/api/workflows";
import { ConfirmAction } from "@/components/common/confirm-action";
import { Page, PageHeader } from "@/components/common/page";
import { PhaseBadge, phaseTone, toneSolid } from "@/components/common/phase-badge";
import { RunTime, TimeDisplayToggle } from "@/components/common/run-time";
import { EmptyState, ErrorState, errorMessage } from "@/components/common/states";
import { SubmitYamlDialog } from "@/components/common/submit-yaml-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useNamespace } from "@/hooks/use-namespace";
import { useNow } from "@/hooks/use-now";
import { formatDuration, parseProgress } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isRunning, isSuspended, sourceTemplate } from "@/lib/workflow";
import { ParamFilter } from "@/workflow/param-filter";
import { RunParams } from "@/workflow/run-params";
import { TemplateFilter } from "@/workflow/template-filter";

const PAGE_SIZE = 50;
const PHASES = ["Running", "Pending", "Succeeded", "Failed", "Error"] as const;

const searchSchema = z.object({
  q: z.string().optional(),
  phases: z.array(z.string()).optional(),
  labels: z.string().optional(),
  params: z.array(z.string()).optional(),
  templates: z.array(z.string()).optional(),
  offset: z.string().optional(),
});

export const Route = createFileRoute("/_app/workflows/")({
  validateSearch: searchSchema,
  component: WorkflowListPage,
});

function WorkflowListPage() {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { namespace } = useNamespace();
  const queryClient = useQueryClient();
  const [q, setQ] = useState(search.q ?? "");
  const [labels, setLabels] = useState(search.labels ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [yamlOpen, setYamlOpen] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "terminate" | undefined>();

  const params = {
    namespace,
    namePattern: search.q || undefined,
    labelSelector: search.labels || undefined,
    phases: search.phases?.length ? search.phases : undefined,
    parameters: search.params?.length ? search.params : undefined,
    templates: search.templates?.length ? search.templates : undefined,
    limit: PAGE_SIZE,
    continueToken: search.offset,
  };
  const query = useQuery(workflowQueries.list(params));
  const items = useMemo(() => query.data?.items ?? [], [query.data]);

  // Live updates: the server's namespace watch sends only changes. Rows on screen are patched in
  // place; anything that changes membership (a new run, a deletion) triggers one debounced refetch,
  // so ordering and paging stay the server's.
  const refetchTimer = useRef<number | undefined>(undefined);
  const listKey = workflowQueries.list(params).queryKey;
  const keyRef = useRef(listKey);
  keyRef.current = listKey;
  useEffect(() => {
    const scheduleRefetch = () => {
      window.clearTimeout(refetchTimer.current);
      refetchTimer.current = window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: keyRef.current }), 800);
    };
    const stop = watchWorkflows(namespace, {
      labelSelector: search.labels || undefined,
      onWorkflow: (wf, type) => {
        let patched = false;
        queryClient.setQueryData<List<Workflow>>(keyRef.current, (current) => {
          if (!current?.items) return current;
          const index = current.items.findIndex((w) => w.metadata.uid === wf.metadata.uid);
          if (index < 0) return current;
          patched = true;
          if (type === "DELETED") return { ...current, items: current.items.filter((_, i) => i !== index) };
          const nextItems = current.items.slice();
          nextItems[index] = wf;
          return { ...current, items: nextItems };
        });
        if (!patched && type !== "MODIFIED") scheduleRefetch();
        if (patched && type === "DELETED") scheduleRefetch();
      },
    });
    return () => {
      window.clearTimeout(refetchTimer.current);
      stop();
    };
  }, [namespace, search.labels, queryClient]);

  const setSearch = (patch: Partial<z.infer<typeof searchSchema>>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch, offset: patch.offset }), replace: true });

  // Typing in the name box filters after a short pause instead of on every key.
  useEffect(() => {
    const id = window.setTimeout(() => {
      if ((search.q ?? "") !== q) setSearch({ q: q || undefined });
    }, 300);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const anyRunning = items.some((wf) => isRunning(wf));
  const now = useNow(anyRunning);

  const selectedItems = items.filter((wf) => selected.has(wf.metadata.uid ?? wf.metadata.name));
  const toggle = (wf: Workflow) => {
    const key = wf.metadata.uid ?? wf.metadata.name;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const bulk = useMutation({
    mutationFn: async (operation: "retry" | "resubmit" | "stop" | "terminate" | "delete") => {
      const results = await Promise.allSettled(
        selectedItems.map((wf) => {
          const { namespace: ns, name } = wf.metadata;
          switch (operation) {
            case "retry":
              return retryWorkflow(ns, name);
            case "resubmit":
              return resubmitWorkflow(ns, name);
            case "stop":
              return stopWorkflow(ns, name);
            case "terminate":
              return terminateWorkflow(ns, name);
            case "delete":
              return deleteWorkflow(ns, name);
          }
        }),
      );
      return results.map((r, i) => ({ name: selectedItems[i].metadata.name, error: r.status === "rejected" ? r.reason : undefined }));
    },
    onSuccess: (results) => {
      const failed = results.filter((r) => r.error);
      if (failed.length === 0) toast.success(t("Done for {{count}} workflows", { count: results.length }));
      else
        toast.error(t("{{failed}} of {{count}} failed", { failed: failed.length, count: results.length }), {
          description: failed.map((f) => `${f.name}: ${errorMessage(f.error)}`).join("\n"),
          duration: 10000,
        });
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
  });

  const remaining = query.data?.metadata?.remainingItemCount ?? 0;
  const offset = Number(search.offset ?? 0);

  return (
    <Page>
      <PageHeader
        title={t("Workflows")}
        description={
          <span className="flex items-center gap-2">
            <span aria-hidden className="size-2 rounded-full bg-phase-ok-solid" />
            {t("Live · only runs you may see are listed")}
          </span>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => setYamlOpen(true)}>
              <FileCode2 aria-hidden />
              {t("Submit YAML")}
            </Button>
            <Button asChild>
              <Link to="/templates">
                <Plus aria-hidden />
                {t("Submit from template")}
              </Link>
            </Button>
          </>
        }
      />

      <section aria-label={t("Filters")} className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3">
        <label className="relative w-full max-w-xs flex-1">
          <span className="sr-only">{t("Search by name")}</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search by name")} className="pl-9" />
        </label>
        <ToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          value={search.phases ?? []}
          onValueChange={(phases) => setSearch({ phases: phases.length ? phases : undefined })}
          aria-label={t("Filter by phase")}
          className="flex-wrap"
        >
          {PHASES.map((phase) => (
            <ToggleGroupItem key={phase} value={phase} className="gap-1.5 px-3">
              <span aria-hidden className={cn("size-2 rounded-full", toneSolid[phaseTone(phase)])} />
              {t(phase)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <TemplateFilter namespace={namespace} value={search.templates ?? []} onChange={(keys) => setSearch({ templates: keys.length ? keys : undefined })} />
        <ParamFilter value={search.params ?? []} onChange={(terms) => setSearch({ params: terms.length ? terms : undefined })} />
        <form
          className="ml-auto flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch({ labels: labels.trim() || undefined });
          }}
        >
          <Input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder={t("Labels, e.g. team=data")} className="h-8 w-56 font-mono text-xs" aria-label={t("Label selector")} />
          {search.labels && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t("Clear label filter")}
              onClick={() => {
                setLabels("");
                setSearch({ labels: undefined });
              }}
            >
              <X aria-hidden />
            </Button>
          )}
        </form>
      </section>

      {selectedItems.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-foreground px-4 py-2.5 text-background">
          <span className="font-semibold">{t("{{count}} selected", { count: selectedItems.length })}</span>
          <span className="text-sm opacity-70">{t("Each one is authorized separately; refusals are reported per run")}</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={bulk.isPending} onClick={() => bulk.mutate("retry")}>
              <RotateCcw aria-hidden />
              {t("Retry")}
            </Button>
            <Button size="sm" variant="secondary" disabled={bulk.isPending} onClick={() => bulk.mutate("resubmit")}>
              {t("Resubmit")}
            </Button>
            <Button size="sm" variant="secondary" disabled={bulk.isPending} onClick={() => bulk.mutate("stop")}>
              <Square aria-hidden />
              {t("Stop")}
            </Button>
            <Button size="sm" variant="secondary" disabled={bulk.isPending} onClick={() => setConfirm("terminate")}>
              {t("Terminate")}
            </Button>
            <Button size="sm" variant="destructive" disabled={bulk.isPending} onClick={() => setConfirm("delete")}>
              <Trash2 aria-hidden />
              {t("Delete")}
            </Button>
          </div>
        </div>
      )}

      {query.error ? (
        <ErrorState error={query.error} />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table className="min-w-[1040px]">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label={t("Select all")}
                      checked={items.length > 0 && selectedItems.length === items.length ? true : selectedItems.length > 0 ? "indeterminate" : false}
                      onCheckedChange={(checked) => setSelected(checked ? new Set(items.map((wf) => wf.metadata.uid ?? wf.metadata.name)) : new Set())}
                    />
                  </TableHead>
                  <TableHead>{t("Name")}</TableHead>
                  <TableHead>{t("Template")}</TableHead>
                  <TableHead>{t("Parameters")}</TableHead>
                  <TableHead>
                    <TimeDisplayToggle label={t("Started")} />
                  </TableHead>
                  <TableHead>{t("Duration")}</TableHead>
                  <TableHead>{t("Status")}</TableHead>
                  <TableHead>{t("Progress")}</TableHead>
                  <TableHead>{t("Message")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.isPending &&
                  Array.from({ length: 8 }, (_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={9}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    </TableRow>
                  ))}
                {items.map((wf) => {
                  const key = wf.metadata.uid ?? wf.metadata.name;
                  const progress = parseProgress(wf.status?.progress);
                  const template = sourceTemplate(wf);
                  const tone = phaseTone(wf.status?.phase, isSuspended(wf));
                  return (
                    <TableRow key={key} data-state={selected.has(key) ? "selected" : undefined}>
                      <TableCell>
                        <Checkbox aria-label={t("Select {{name}}", { name: wf.metadata.name })} checked={selected.has(key)} onCheckedChange={() => toggle(wf)} />
                      </TableCell>
                      <TableCell>
                        <Link
                          to="/workflows/$namespace/$name"
                          params={{ namespace: wf.metadata.namespace, name: wf.metadata.name }}
                          className="font-mono text-[13px] font-medium text-primary hover:underline"
                        >
                          {wf.metadata.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {template ? (
                          <Link to="/templates/$namespace/$name" params={{ namespace: wf.metadata.namespace, name: template }} className="hover:text-foreground hover:underline">
                            {template}
                          </Link>
                        ) : (
                          wf.spec.workflowTemplateRef?.clusterScope ? (
                            <span>{wf.spec.workflowTemplateRef.name} <span className="text-xs">({t("cluster")})</span></span>
                          ) : "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <RunParams params={wf.spec.arguments?.parameters} onFilter={(term) => setSearch({ params: [...(search.params ?? []).filter((t) => t !== term), term] })} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <RunTime value={wf.status?.startedAt ?? wf.metadata.creationTimestamp} />
                      </TableCell>
                      <TableCell className="font-mono text-[13px]">{formatDuration(wf.status?.startedAt, wf.status?.finishedAt, now)}</TableCell>
                      <TableCell>
                        <PhaseBadge phase={wf.status?.phase} suspended={isSuspended(wf)} />
                      </TableCell>
                      <TableCell>
                        {progress ? (
                          <div className="flex items-center gap-2">
                            <div aria-hidden className="h-1 w-16 overflow-hidden rounded bg-muted">
                              <div className={cn("h-1", toneSolid[tone])} style={{ width: `${progress[1] ? (progress[0] / progress[1]) * 100 : 0}%` }} />
                            </div>
                            <span className="font-mono text-xs text-muted-foreground">{wf.status?.progress}</span>
                          </div>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="max-w-80 truncate text-muted-foreground" title={wf.status?.message}>
                        {wf.status?.message ?? ""}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {!query.isPending && items.length === 0 && (
            <EmptyState
              title={t("No workflows")}
              description={search.q || search.phases || search.labels ? t("Nothing matches these filters.") : t("Runs you may see in this namespace will appear here.")}
            />
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span>
          {items.length > 0 &&
            t("{{from}}–{{to}}, newest first", { from: offset + 1, to: offset + items.length })}
        </span>
        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setSearch({ offset: offset - PAGE_SIZE > 0 ? String(offset - PAGE_SIZE) : undefined })}
          >
            {t("Previous")}
          </Button>
          <Button variant="outline" size="sm" disabled={remaining <= 0} onClick={() => setSearch({ offset: query.data?.metadata?.continue ?? undefined })}>
            {t("Next")}
          </Button>
        </div>
      </div>

      <SubmitYamlDialog open={yamlOpen} onOpenChange={setYamlOpen} namespace={namespace} />
      <ConfirmAction
        open={!!confirm}
        onOpenChange={(open) => !open && setConfirm(undefined)}
        title={confirm === "delete" ? t("Delete {{count}} workflows?", { count: selectedItems.length }) : t("Terminate {{count}} workflows?", { count: selectedItems.length })}
        description={confirm === "delete" ? t("Deleted runs and their logs cannot be recovered.") : t("Running steps are killed immediately, without exit handlers.")}
        confirmLabel={confirm === "delete" ? t("Delete") : t("Terminate")}
        onConfirm={() => {
          if (confirm) bulk.mutate(confirm);
          setConfirm(undefined);
        }}
      />
    </Page>
  );
}
