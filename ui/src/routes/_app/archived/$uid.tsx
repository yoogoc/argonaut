import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Archive, RotateCcw, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";

import { archiveQueries, deleteArchived, resubmitArchived, retryArchived } from "@/api/archive";
import { useActions } from "@/api/authz";
import { ConfirmAction } from "@/components/common/confirm-action";
import { Mono } from "@/components/common/page";
import { PhaseBadge } from "@/components/common/phase-badge";
import { ErrorState, errorMessage, Spinner } from "@/components/common/states";
import { YamlEditor } from "@/components/common/yaml-editor";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ArtifactRef } from "@/graph/runtime";
import { formatDuration, formatTimestamp } from "@/lib/format";
import { sourceTemplate } from "@/lib/workflow";
import { toYaml } from "@/lib/yaml";
import { ArtifactPanel } from "@/workflow/artifact-panel";
import { ArtifactsTab, parseArtifactParam, ParametersTab, SummaryTab } from "@/workflow/detail-tabs";
import { NodePanel } from "@/workflow/node-panel";
import { RunGraph } from "@/workflow/run-graph";
import { RunOptionsDialog, type RunOptions } from "@/workflow/run-options-dialog";
import { RunSourceProvider } from "@/workflow/run-source";
import { Timeline } from "@/workflow/timeline";

const TABS = ["graph", "summary", "timeline", "parameters", "artifacts", "yaml"] as const;

const searchSchema = z.object({
  tab: z.enum(TABS).optional(),
  nodeId: z.string().optional(),
  artifact: z.string().optional(),
  retries: z.enum(["expanded", "collapsed"]).optional(),
});

export const Route = createFileRoute("/_app/archived/$uid")({
  validateSearch: searchSchema,
  loader: ({ context, params }) => context.queryClient.ensureQueryData(archiveQueries.detail(params.uid)),
  pendingComponent: () => <Spinner className="mt-20" />,
  errorComponent: ({ error }) => <ErrorState error={error} className="m-6" />,
  component: ArchivedDetailPage,
});

/**
 * An archived run: the same graph, timeline, node panel and artifacts as a live one, read from the
 * archive. Nothing here changes, so there is no watch; logs and artifacts come from the artifact
 * repository. Resubmit creates a new run, and retry brings this one back into the cluster.
 */
function ArchivedDetailPage() {
  const { t } = useTranslation();
  const { uid } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  const { data: workflow } = useQuery(archiveQueries.detail(uid));
  const template = workflow ? sourceTemplate(workflow) : undefined;
  const namespace = workflow?.metadata.namespace ?? "";
  const { can } = useActions(workflow ? { namespace, template: workflow.spec.workflowTemplateRef?.clusterScope ? undefined : template } : undefined);

  const [resubmitOpen, setResubmitOpen] = useState(false);
  const [retryOpen, setRetryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const tab = search.tab ?? "graph";
  const setSearch = (patch: Partial<z.infer<typeof searchSchema>>) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
  const selectNode = (id?: string) => setSearch({ nodeId: id, artifact: undefined });
  const selectArtifact = (ref?: ArtifactRef) => setSearch({ artifact: ref ? `${ref.isInput ? "in" : "out"}:${ref.nodeId}/${ref.name}` : undefined, nodeId: undefined });
  const selectedArtifact = parseArtifactParam(search.artifact);

  const openRun = (next: { metadata: { namespace: string; name: string } }) =>
    void navigate({ to: "/workflows/$namespace/$name", params: { namespace: next.metadata.namespace, name: next.metadata.name } });
  const resubmit = useMutation({
    mutationFn: (o: RunOptions) => resubmitArchived(uid, { memoized: o.memoized, parameters: o.parameters.length ? o.parameters : undefined }),
    onSuccess: openRun,
  });
  const retry = useMutation({
    mutationFn: (o: RunOptions) => retryArchived(uid, { restartSuccessful: !o.memoized, parameters: o.parameters.length ? o.parameters : undefined }),
    onSuccess: openRun,
  });
  const remove = useMutation({
    mutationFn: () => deleteArchived(uid),
    onSuccess: () => {
      toast.success(t("Removed from the archive"));
      void queryClient.invalidateQueries({ queryKey: ["archived"] });
      void navigate({ to: "/archived" });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!workflow) return null;
  const nodes = workflow.status?.nodes ?? {};
  const phase = workflow.status?.phase;
  const selectedNode = search.nodeId ? nodes[search.nodeId] : undefined;
  const artifactNode = selectedArtifact ? nodes[selectedArtifact.nodeId] : undefined;
  const artifactDetail = selectedArtifact ? (selectedArtifact.isInput ? artifactNode?.inputs : artifactNode?.outputs)?.artifacts?.find((a) => a.name === selectedArtifact.name) : undefined;
  const failed = phase === "Failed" || phase === "Error";

  return (
    <RunSourceProvider value={{ archivedUid: uid }}>
      <div className="flex min-h-0 flex-1 flex-col">
        <section className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b bg-background px-4 pt-4 sm:px-6">
          <div className="flex min-w-0 flex-col gap-1.5">
            <nav aria-label={t("Breadcrumb")} className="flex gap-1.5 text-[13px] text-muted-foreground">
              <Link to="/archived" className="hover:text-foreground">
                {t("Archive")}
              </Link>
              <span aria-hidden>/</span>
              <span className="font-mono">{namespace}</span>
            </nav>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-mono text-xl font-semibold">{workflow.metadata.name}</h1>
              <PhaseBadge phase={phase} />
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                <Archive className="size-3" aria-hidden />
                {t("Archived")}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-muted-foreground">
              {template && (
                <span>
                  {t("Template")}{" "}
                  <Link to="/templates/$namespace/$name" params={{ namespace, name: template }} className="font-mono text-primary hover:underline">
                    {template}
                  </Link>
                </span>
              )}
              <span>
                {t("Started")} {formatTimestamp(workflow.status?.startedAt)}
              </span>
              <span>
                {t("Duration")} <Mono>{formatDuration(workflow.status?.startedAt, workflow.status?.finishedAt)}</Mono>
              </span>
              <span>
                UID <Mono>{uid}</Mono>
              </span>
            </div>
          </div>
          <div role="toolbar" aria-label={t("Operations")} className="ml-auto flex flex-wrap gap-2">
            {can("workflow:retry") && failed && (
              <Button variant="outline" size="sm" onClick={() => setRetryOpen(true)}>
                <RotateCcw aria-hidden />
                {t("Retry")}
              </Button>
            )}
            {can("workflow:resubmit") && (
              <Button variant="outline" size="sm" onClick={() => setResubmitOpen(true)}>
                <Zap aria-hidden />
                {t("Resubmit")}
              </Button>
            )}
            {can("workflow:delete") && (
              <Button variant="outline" size="sm" className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 aria-hidden />
                {t("Delete")}
              </Button>
            )}
          </div>
          <Tabs value={tab} onValueChange={(v) => setSearch({ tab: v as (typeof TABS)[number] })} className="-mx-4 basis-full sm:-mx-6">
            <TabsList variant="line" className="w-full justify-start gap-5 overflow-x-auto px-4 sm:px-6">
              {TABS.map((id) => (
                <TabsTrigger key={id} value={id}>
                  {t({ graph: "Graph", summary: "Summary", timeline: "Timeline", parameters: "Parameters", artifacts: "Artifacts", yaml: "YAML" }[id])}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </section>

        <div className="flex min-h-[560px] flex-1 flex-col lg:min-h-0 lg:flex-row">
          <div className="relative flex min-h-[420px] min-w-0 flex-1 flex-col bg-canvas">
            {tab === "graph" && (
              <>
                <div className="flex items-center gap-1.5 px-4 py-3">
                  <Switch id="a-retries" checked={search.retries === "expanded"} onCheckedChange={(v) => setSearch({ retries: v ? "expanded" : undefined })} />
                  <Label htmlFor="a-retries" className="text-[13px] font-normal">
                    {t("Expand retry attempts")}
                  </Label>
                </div>
                <div className="min-h-0 flex-1">
                  <RunGraph
                    workflow={workflow}
                    selectedNodeId={search.nodeId}
                    selectedArtifact={selectedArtifact}
                    expandRetries={search.retries === "expanded"}
                    showArtifacts
                    onSelectNode={(n) => selectNode(n.id)}
                    onSelectArtifact={selectArtifact}
                  />
                </div>
              </>
            )}
            {tab === "summary" && <SummaryTab workflow={workflow} />}
            {tab === "timeline" && (
              <div className="min-h-0 flex-1 p-4">
                <Timeline workflow={workflow} onSelect={(id) => selectNode(id)} selectedId={search.nodeId} />
              </div>
            )}
            {tab === "parameters" && <ParametersTab workflow={workflow} />}
            {tab === "artifacts" && <ArtifactsTab workflow={workflow} onSelect={selectArtifact} />}
            {tab === "yaml" && (
              <div className="min-h-0 flex-1 p-4">
                <YamlEditor value={toYaml(workflow)} readOnly path={`archived-${uid}.yaml`} className="h-full min-h-[480px] bg-card" />
              </div>
            )}
          </div>
          {artifactNode && artifactDetail && selectedArtifact && (
            <ArtifactPanel workflow={workflow} node={artifactNode} artifact={artifactDetail} isInput={selectedArtifact.isInput} onClose={() => selectArtifact(undefined)} onSelectNode={(n) => selectNode(n.id)} />
          )}
          {!artifactDetail && selectedNode && <NodePanel workflow={workflow} node={selectedNode} onClose={() => selectNode(undefined)} onRetryNode={() => setRetryOpen(true)} onSelectNode={(n) => selectNode(n.id)} canRetry={false} />}
        </div>

        <RunOptionsDialog
          open={resubmitOpen}
          onOpenChange={setResubmitOpen}
          title={t("Resubmit {{name}}", { name: workflow.metadata.name })}
          description={t("Creates a new workflow from this one.")}
          workflow={workflow}
          confirmLabel={t("Resubmit")}
          memoizedLabel={t("Memoized")}
          memoizedHint={t("Reuse the steps that already succeeded instead of running them again.")}
          memoizedDisabledReason={failed ? undefined : t("Only a failed or errored run can be resubmitted in memoized mode.")}
          exclusive
          pending={resubmit.isPending}
          error={resubmit.error}
          onConfirm={(o) => resubmit.mutate(o)}
        />
        <RunOptionsDialog
          open={retryOpen}
          onOpenChange={setRetryOpen}
          title={t("Retry {{name}}", { name: workflow.metadata.name })}
          description={t("Restores this run to the cluster and re-runs its failed steps.")}
          workflow={workflow}
          confirmLabel={t("Retry")}
          memoizedLabel={t("Keep successful steps")}
          memoizedHint={t("Clear it to also re-run steps that already succeeded.")}
          memoizedDefault
          pending={retry.isPending}
          error={retry.error}
          onConfirm={(o) => retry.mutate(o)}
        />
        <ConfirmAction
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={t("Remove this run from the archive?")}
          description={t("The archived record is deleted permanently. Its artifacts stay in the artifact repository.")}
          confirmLabel={t("Delete")}
          typeToConfirm={workflow.metadata.name}
          onConfirm={() => {
            setConfirmDelete(false);
            remove.mutate();
          }}
        />
      </div>
    </RunSourceProvider>
  );
}
