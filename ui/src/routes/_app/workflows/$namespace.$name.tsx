import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Pause, Play, RotateCcw, Square, Trash2, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";

import { useActions } from "@/api/authz";
import type { NodeStatus, Workflow, WorkflowEvent } from "@/api/types";
import {
  deleteWorkflow,
  resubmitWorkflow,
  resumeWorkflow,
  retryWorkflow,
  setWorkflowNode,
  stopWorkflow,
  suspendWorkflow,
  terminateWorkflow,
  watchWorkflowEvents,
  watchWorkflows,
  workflowQueries,
} from "@/api/workflows";
import { ConfirmAction } from "@/components/common/confirm-action";
import { Mono } from "@/components/common/page";
import { PhaseBadge } from "@/components/common/phase-badge";
import { EmptyState, ErrorState, errorMessage, Spinner } from "@/components/common/states";
import { YamlEditor } from "@/components/common/yaml-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ArtifactRef } from "@/graph/runtime";
import { useNow } from "@/hooks/use-now";
import { formatDuration, formatTimestamp } from "@/lib/format";
import { isOperationDisabled, isSuspended, sourceTemplate, suspendedNodes } from "@/lib/workflow";
import { toYaml } from "@/lib/yaml";
import { ArtifactPanel } from "@/workflow/artifact-panel";
import { DesignOverlay } from "@/workflow/design-overlay";
import { NodePanel } from "@/workflow/node-panel";
import { RunGraph } from "@/workflow/run-graph";
import { RunOptionsDialog, type RunOptions } from "@/workflow/run-options-dialog";
import { ArtifactsTab, parseArtifactParam, ParametersTab, SummaryTab } from "@/workflow/detail-tabs";
import { Timeline } from "@/workflow/timeline";

const TABS = ["graph", "summary", "timeline", "events", "parameters", "artifacts", "yaml"] as const;

const searchSchema = z.object({
  tab: z.enum(TABS).optional(),
  nodeId: z.string().optional(),
  artifact: z.string().optional(),
  retries: z.enum(["expanded", "collapsed"]).optional(),
  view: z.enum(["run", "design"]).optional(),
  artifacts: z.boolean().optional(),
});

export const Route = createFileRoute("/_app/workflows/$namespace/$name")({
  validateSearch: searchSchema,
  loader: ({ context, params }) => context.queryClient.ensureQueryData(workflowQueries.detail(params.namespace, params.name)),
  pendingComponent: () => <Spinner className="mt-20" />,
  errorComponent: ({ error }) => <ErrorState error={error} className="m-6" />,
  component: WorkflowDetailPage,
});

function WorkflowDetailPage() {
  const { t } = useTranslation();
  const { namespace, name } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  const query = useQuery(workflowQueries.detail(namespace, name));
  const [live, setLive] = useState<Workflow>();
  const [watchError, setWatchError] = useState<unknown>();

  // The detail page follows one workflow in full; every update replaces the rendered object. The
  // server ends the stream if this user's access is revoked.
  useEffect(() => {
    setLive(undefined);
    setWatchError(undefined);
    return watchWorkflows(namespace, { name, onWorkflow: (wf) => setLive(wf), onError: setWatchError });
  }, [namespace, name]);

  const workflow = live ?? query.data;
  const template = workflow ? sourceTemplate(workflow) : undefined;
  const { can } = useActions(workflow ? { namespace, template: workflow.spec.workflowTemplateRef?.clusterScope ? undefined : template } : undefined);
  const now = useNow(workflow?.status?.phase === "Running");

  const tab = search.tab ?? "graph";
  const selectedArtifact = parseArtifactParam(search.artifact);
  const expandRetries = search.retries === "expanded";
  const setSearch = (patch: Partial<z.infer<typeof searchSchema>>) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
  const selectNode = (id?: string) => setSearch({ nodeId: id, artifact: undefined });
  const selectArtifact = (ref?: ArtifactRef) => setSearch({ artifact: ref ? `${ref.isInput ? "in" : "out"}:${ref.nodeId}/${ref.name}` : undefined, nodeId: undefined });

  const [resubmitOpen, setResubmitOpen] = useState(false);
  const [retryNode, setRetryNode] = useState<NodeStatus>();
  const [confirm, setConfirm] = useState<"terminate" | "delete">();

  const operate = useMutation({
    mutationFn: async (op: "retry" | "suspend" | "resume" | "stop" | "terminate" | "delete") => {
      switch (op) {
        case "retry":
          return retryWorkflow(namespace, name);
        case "suspend":
          return suspendWorkflow(namespace, name);
        case "resume":
          return resumeWorkflow(namespace, name);
        case "stop":
          return stopWorkflow(namespace, name);
        case "terminate":
          return terminateWorkflow(namespace, name);
        case "delete":
          await deleteWorkflow(namespace, name);
          return undefined;
      }
    },
    onSuccess: (_result, op) => {
      toast.success(t("{{op}} requested", { op: t(op[0].toUpperCase() + op.slice(1)) }));
      if (op === "delete") {
        void queryClient.invalidateQueries({ queryKey: ["workflows"] });
        void navigate({ to: "/workflows" });
      } else void query.refetch();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const resubmit = useMutation({
    mutationFn: (o: RunOptions) => resubmitWorkflow(namespace, name, { memoized: o.memoized, parameters: o.parameters.length ? o.parameters : undefined }),
    onSuccess: (next) => {
      setResubmitOpen(false);
      void navigate({ to: "/workflows/$namespace/$name", params: { namespace: next.metadata.namespace, name: next.metadata.name } });
    },
  });
  const retryNodeMutation = useMutation({
    mutationFn: ({ node, o }: { node: NodeStatus; o: RunOptions }) =>
      // Argo's retry has no memoized flag: keeping successful steps is not restarting them.
      retryWorkflow(namespace, name, { nodeFieldSelector: `id=${node.id}`, restartSuccessful: !o.memoized, parameters: o.parameters.length ? o.parameters : undefined }),
    onSuccess: () => {
      setRetryNode(undefined);
      void query.refetch();
    },
  });

  if (!workflow) return <ErrorState error={query.error ?? new Error(t("Workflow not found"))} className="m-6" />;

  const nodes = workflow.status?.nodes ?? {};
  const selectedNode = search.nodeId ? nodes[search.nodeId] : undefined;
  const artifactNode = selectedArtifact ? nodes[selectedArtifact.nodeId] : undefined;
  const artifactDetail = selectedArtifact ? (selectedArtifact.isInput ? artifactNode?.inputs : artifactNode?.outputs)?.artifacts?.find((a) => a.name === selectedArtifact.name) : undefined;
  const suspended = isSuspended(workflow);
  const phase = workflow.status?.phase;

  const opButton = (op: "retry" | "suspend" | "resume" | "stop" | "terminate" | "delete", action: string, icon: React.ReactNode, label: string, destructive = false) => {
    if (!can(action)) return null;
    const key = op.toUpperCase() as Parameters<typeof isOperationDisabled>[0];
    const disabled = isOperationDisabled(key, workflow) || operate.isPending;
    const button = (
      <Button
        variant={destructive ? "outline" : "outline"}
        size="sm"
        className={destructive ? "border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" : undefined}
        disabled={disabled}
        onClick={() => (op === "terminate" || op === "delete" ? setConfirm(op) : operate.mutate(op))}
      >
        {icon}
        {label}
      </Button>
    );
    if (!disabled || operate.isPending) return <span key={op}>{button}</span>;
    return (
      <Tooltip key={op}>
        <TooltipTrigger asChild>
          <span tabIndex={0}>{button}</span>
        </TooltipTrigger>
        <TooltipContent>{t("Not available while the run is {{phase}}", { phase: t(phase ?? "Pending") })}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b bg-background px-4 pt-4 sm:px-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          <nav aria-label={t("Breadcrumb")} className="flex gap-1.5 text-[13px] text-muted-foreground">
            <Link to="/workflows" className="hover:text-foreground">
              {t("Workflows")}
            </Link>
            <span aria-hidden>/</span>
            <span className="font-mono">{namespace}</span>
          </nav>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-mono text-xl font-semibold">{name}</h1>
            <PhaseBadge phase={phase} suspended={suspended} />
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
            {workflow.spec.workflowTemplateRef?.clusterScope && (
              <span>
                {t("Cluster template")}{" "}
                <Link to="/cluster-templates/$name" params={{ name: workflow.spec.workflowTemplateRef.name }} className="font-mono text-primary hover:underline">
                  {workflow.spec.workflowTemplateRef.name}
                </Link>
              </span>
            )}
            <span>
              {t("Started")} {formatTimestamp(workflow.status?.startedAt)}
            </span>
            <span>
              {t("Duration")} <Mono>{formatDuration(workflow.status?.startedAt, workflow.status?.finishedAt, now)}</Mono>
            </span>
            {workflow.status?.progress && (
              <span>
                {t("Progress")} <Mono>{workflow.status.progress}</Mono>
              </span>
            )}
            {workflow.metadata.labels?.["workflows.argoproj.io/creator"] && (
              <span>
                {t("Submitted by")} {workflow.metadata.labels["workflows.argoproj.io/creator"]}
              </span>
            )}
          </div>
        </div>
        <div role="toolbar" aria-label={t("Operations")} className="ml-auto flex flex-wrap gap-2">
          {opButton("retry", "workflow:retry", <RotateCcw aria-hidden />, t("Retry"))}
          {can("workflow:resubmit") && (
            <Button variant="outline" size="sm" onClick={() => setResubmitOpen(true)}>
              <Zap aria-hidden />
              {t("Resubmit")}
            </Button>
          )}
          {suspended ? opButton("resume", "workflow:resume", <Play aria-hidden />, t("Resume")) : opButton("suspend", "workflow:suspend", <Pause aria-hidden />, t("Suspend"))}
          {opButton("stop", "workflow:stop", <Square aria-hidden />, t("Stop"))}
          {opButton("terminate", "workflow:terminate", null, t("Terminate"), true)}
          {opButton("delete", "workflow:delete", <Trash2 aria-hidden />, t("Delete"), true)}
        </div>
        <Tabs value={tab} onValueChange={(v) => setSearch({ tab: v as (typeof TABS)[number] })} className="-mx-4 basis-full sm:-mx-6">
          <TabsList variant="line" className="w-full justify-start gap-5 overflow-x-auto px-4 sm:px-6">
            {TABS.map((id) => (
              <TabsTrigger key={id} value={id}>
                {t({ graph: "Graph", summary: "Summary", timeline: "Timeline", events: "Events", parameters: "Parameters", artifacts: "Artifacts", yaml: "YAML" }[id])}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </section>

      {watchError !== undefined && <ErrorState error={watchError} className="mx-4 mt-3 sm:mx-6" title={t("Live updates stopped")} />}
      {suspended && can("workflow:resume") && <SuspendInputs workflow={workflow} onDone={() => void query.refetch()} />}

      <div className="flex min-h-[560px] flex-1 flex-col lg:flex-row">
        <div className="relative flex min-h-[420px] min-w-0 flex-1 flex-col bg-canvas">
          {tab === "graph" && (
            <>
              <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                <ToggleGroup type="single" variant="outline" size="sm" value={search.view ?? "run"} onValueChange={(v) => v && setSearch({ view: v as "run" | "design" })} aria-label={t("Graph view")}>
                  <ToggleGroupItem value="run" className="px-3">
                    {t("Run view")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="design" className="px-3">
                    {t("Design view")}
                  </ToggleGroupItem>
                </ToggleGroup>
                {(search.view ?? "run") === "run" && (
                  <>
                    <div className="flex items-center gap-1.5">
                      <Switch id="g-artifacts" checked={search.artifacts !== false} onCheckedChange={(v) => setSearch({ artifacts: v ? undefined : false })} />
                      <Label htmlFor="g-artifacts" className="text-[13px] font-normal">
                        {t("Show artifacts")}
                      </Label>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Switch id="g-retries" checked={expandRetries} onCheckedChange={(v) => setSearch({ retries: v ? "expanded" : undefined })} />
                      <Label htmlFor="g-retries" className="text-[13px] font-normal">
                        {t("Expand retry attempts")}
                      </Label>
                    </div>
                  </>
                )}
              </div>
              <div className="min-h-0 flex-1">
                {(search.view ?? "run") === "run" ? (
                  <RunGraph
                    workflow={workflow}
                    selectedNodeId={search.nodeId}
                    selectedArtifact={selectedArtifact}
                    expandRetries={expandRetries}
                    showArtifacts={search.artifacts !== false}
                    onSelectNode={(n) => selectNode(n.id)}
                    onSelectArtifact={selectArtifact}
                  />
                ) : (
                  <DesignOverlay workflow={workflow} onSelectNode={(id) => selectNode(id)} />
                )}
              </div>
            </>
          )}
          {tab === "summary" && <SummaryTab workflow={workflow} />}
          {tab === "timeline" && (
            <div className="min-h-0 flex-1 p-4">
              <Timeline workflow={workflow} onSelect={(id) => selectNode(id)} selectedId={search.nodeId} />
            </div>
          )}
          {tab === "events" && <EventsTab namespace={namespace} name={name} />}
          {tab === "parameters" && <ParametersTab workflow={workflow} />}
          {tab === "artifacts" && <ArtifactsTab workflow={workflow} onSelect={selectArtifact} />}
          {tab === "yaml" && (
            <div className="min-h-0 flex-1 p-4">
              <YamlEditor value={toYaml(workflow)} readOnly path={`wf-${namespace}-${name}.yaml`} className="h-full min-h-[480px] bg-card" />
            </div>
          )}
        </div>
        {artifactNode && artifactDetail && selectedArtifact && (
          <ArtifactPanel workflow={workflow} node={artifactNode} artifact={artifactDetail} isInput={selectedArtifact.isInput} onClose={() => selectArtifact(undefined)} onSelectNode={(n) => selectNode(n.id)} />
        )}
        {!artifactDetail && selectedNode && (
          <NodePanel workflow={workflow} node={selectedNode} onClose={() => selectNode(undefined)} onRetryNode={setRetryNode} onSelectNode={(n) => selectNode(n.id)} canRetry={can("workflow:retry")} />
        )}
      </div>

      <RunOptionsDialog
        open={resubmitOpen}
        onOpenChange={setResubmitOpen}
        title={t("Resubmit {{name}}", { name })}
        description={t("Creates a new workflow from this one.")}
        workflow={workflow}
        confirmLabel={t("Resubmit")}
        memoizedLabel={t("Memoized")}
        memoizedHint={t("Reuse the steps that already succeeded instead of running them again.")}
        memoizedDisabledReason={phase === "Failed" || phase === "Error" ? undefined : t("Only a failed or errored run can be resubmitted in memoized mode.")}
        exclusive
        pending={resubmit.isPending}
        error={resubmit.error}
        onConfirm={(o) => resubmit.mutate(o)}
      />
      {retryNode && (
        <RunOptionsDialog
          open
          onOpenChange={(open) => !open && setRetryNode(undefined)}
          title={t("Retry node {{name}}", { name: retryNode.displayName || retryNode.name })}
          description={t("Re-runs this step within the existing workflow.")}
          workflow={workflow}
          confirmLabel={t("Retry node")}
          memoizedLabel={t("Keep successful steps")}
          memoizedHint={t("Clear it to also re-run steps that already succeeded.")}
          memoizedDefault={retryNode.phase === "Failed" || retryNode.phase === "Error"}
          pending={retryNodeMutation.isPending}
          error={retryNodeMutation.error}
          onConfirm={(o) => retryNodeMutation.mutate({ node: retryNode, o })}
        />
      )}
      <ConfirmAction
        open={!!confirm}
        onOpenChange={(open) => !open && setConfirm(undefined)}
        title={confirm === "delete" ? t("Delete this workflow?") : t("Terminate this workflow?")}
        description={confirm === "delete" ? t("The run, its node status and its logs are removed.") : t("Running steps are killed immediately, without exit handlers.")}
        confirmLabel={confirm === "delete" ? t("Delete") : t("Terminate")}
        typeToConfirm={name}
        onConfirm={() => {
          if (confirm) operate.mutate(confirm);
          setConfirm(undefined);
        }}
      />
    </div>
  );
}

function EventsTab({ namespace, name }: { namespace: string; name: string }) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    setEvents([]);
    return watchWorkflowEvents(namespace, name, { onEvent: (e) => setEvents((c) => [...c, e]), onError: setError });
  }, [namespace, name]);
  return (
    <div className="space-y-3 p-4">
      {error !== undefined && <ErrorState error={error} />}
      {events.length === 0 ? (
        <EmptyState title={t("No events")} description={t("Kubernetes discards events after about an hour, so older runs usually have none.")} />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead>{t("Type")}</TableHead>
                <TableHead>{t("Reason")}</TableHead>
                <TableHead>{t("Object")}</TableHead>
                <TableHead>{t("Message")}</TableHead>
                <TableHead>{t("Last seen")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e, i) => (
                <TableRow key={`${e.objectName}-${e.reason}-${i}`}>
                  <TableCell className={e.type === "Warning" ? "text-phase-susp font-semibold" : ""}>{e.type}</TableCell>
                  <TableCell>{e.reason}</TableCell>
                  <TableCell className="font-mono text-xs">{e.objectName}</TableCell>
                  <TableCell className="max-w-[480px] whitespace-normal">{e.message}</TableCell>
                  <TableCell className="text-muted-foreground">{formatTimestamp(e.lastTimestamp)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/**
 * "Resume with inputs": a suspended node's supplied parameters are written with Set, then the node is
 * released — resume alone would release it with the defaults.
 */
function SuspendInputs({ workflow, onDone }: { workflow: Workflow; onDone: () => void }) {
  const { t } = useTranslation();
  const nodes = suspendedNodes(workflow);
  const [values, setValues] = useState<Record<string, string>>({});
  const resume = useMutation({
    mutationFn: async (node: NodeStatus) => {
      const selector = `id=${node.id}`;
      const outputs = Object.fromEntries(
        (node.outputs?.parameters ?? []).map((p) => [p.name, values[`${node.id}:${p.name}`] ?? p.value ?? ""] as const).filter(([, v]) => v !== ""),
      );
      if (Object.keys(outputs).length) await setWorkflowNode(workflow.metadata.namespace, workflow.metadata.name, selector, outputs);
      return resumeWorkflow(workflow.metadata.namespace, workflow.metadata.name, selector);
    },
    onSuccess: onDone,
  });
  return (
    <div className="mx-4 mt-3 space-y-3 rounded-xl border border-phase-susp-solid/40 bg-phase-susp-bg/50 p-4 sm:mx-6">
      <h2 className="font-semibold text-phase-susp">{t("Waiting for input")}</h2>
      {resume.error !== null && resume.error !== undefined && <ErrorState error={resume.error} />}
      {nodes.map((node) => (
        <div key={node.id} className="flex flex-wrap items-end gap-3">
          <span className="font-mono text-sm font-semibold">{node.displayName}</span>
          {(node.outputs?.parameters ?? []).map((p) => (
            <label key={p.name} className="flex flex-col gap-1 text-xs">
              <span className="font-mono">{p.name}</span>
              <Input value={values[`${node.id}:${p.name}`] ?? p.value ?? ""} onChange={(e) => setValues((c) => ({ ...c, [`${node.id}:${p.name}`]: e.target.value }))} className="h-8 w-48 bg-card font-mono text-xs" />
            </label>
          ))}
          <Button size="sm" disabled={resume.isPending} onClick={() => resume.mutate(node)}>
            <Play aria-hidden />
            {t("Resume")}
          </Button>
        </div>
      ))}
    </div>
  );
}
