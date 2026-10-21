import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Layers, Pencil, Play, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useActions } from "@/api/authz";
import { COMPONENT_LABEL, deleteTemplate, MODIFIED_BY_ANNOTATION, runLabelSelector, type TemplateRef, templateQueries } from "@/api/templates";
import type { WorkflowTemplate } from "@/api/types";
import { workflowQueries } from "@/api/workflows";
import { ConfirmAction } from "@/components/common/confirm-action";
import { Mono, Section } from "@/components/common/page";
import { PhaseBadge } from "@/components/common/phase-badge";
import { EmptyState, ErrorState, errorMessage } from "@/components/common/states";
import { YamlEditor } from "@/components/common/yaml-editor";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type SpecLike, type TemplateRefLike } from "@/graph/spec";
import { SpecGraphView } from "@/graph/spec-view";
import { useNamespace } from "@/hooks/use-namespace";
import { formatDuration, formatRelative } from "@/lib/format";
import { isSuspended } from "@/lib/workflow";
import { toYaml } from "@/lib/yaml";

import { Revisions } from "./revisions";
import { SubmitPanel } from "./submit-panel";

export type DetailTab = "overview" | "runs" | "yaml" | "revisions";

/** Every templateRef a spec makes, for the "referenced components" card and its permission check. */
function referencedTemplates(spec: SpecLike): TemplateRefLike[] {
  const seen = new Map<string, TemplateRefLike>();
  for (const t of spec.templates ?? []) {
    for (const task of t.dag?.tasks ?? []) if (task.templateRef?.name) seen.set(`${task.templateRef.clusterScope}/${task.templateRef.name}`, task.templateRef);
    for (const group of t.steps ?? []) for (const step of group) if (step.templateRef?.name) seen.set(`${step.templateRef.clusterScope}/${step.templateRef.name}`, step.templateRef);
  }
  return [...seen.values()];
}

/** Shared by /templates/$ns/$name and /cluster-templates/$name. */
export function TemplateDetail({ templateRef, tab, onTab }: { templateRef: TemplateRef; tab: DetailTab; onTab: (tab: DetailTab) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery(templateQueries.detail(templateRef));
  const { can } = useActions(templateRef.cluster ? { clusterTemplate: templateRef.name } : { namespace: templateRef.namespace, template: templateRef.name });
  const { namespace: currentNs } = useNamespace();
  // A cluster template's runs live in namespaces; this page shows those of the current one.
  const runNs = templateRef.cluster ? currentNs : templateRef.namespace;
  const nsActions = useActions(templateRef.cluster ? { namespace: currentNs } : undefined);
  const canSubmit = templateRef.cluster ? nsActions.can("workflow:submit") : can("workflow:submit");
  const [submitOpen, setSubmitOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const remove = useMutation({
    mutationFn: () => deleteTemplate(templateRef),
    onSuccess: () => {
      toast.success(t("Template deleted"));
      void queryClient.invalidateQueries({ queryKey: ["templates"] });
      void navigate({ to: templateRef.cluster ? "/cluster-templates" : "/templates" });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (query.error) return <ErrorState error={query.error} className="m-6" />;
  const tpl = query.data;
  if (!tpl) return null;

  const editLink = templateRef.cluster ? (
    <Link to="/cluster-templates/$name/edit" params={{ name: templateRef.name }}>
      <Pencil aria-hidden />
      {t("Edit in editor")}
    </Link>
  ) : (
    <Link to="/templates/$namespace/$name/edit" params={{ namespace: templateRef.namespace, name: templateRef.name }}>
      <Pencil aria-hidden />
      {t("Edit in editor")}
    </Link>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section className="flex flex-wrap items-end gap-x-4 gap-y-3 border-b bg-background px-4 pt-5 sm:px-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          <nav aria-label={t("Breadcrumb")} className="flex gap-1.5 text-[13px] text-muted-foreground">
            <Link to={templateRef.cluster ? "/cluster-templates" : "/templates"} className="hover:text-foreground">
              {templateRef.cluster ? t("Cluster templates") : t("Templates")}
            </Link>
            {!templateRef.cluster && (
              <>
                <span aria-hidden>/</span>
                <span className="font-mono">{templateRef.namespace}</span>
              </>
            )}
          </nav>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-mono text-[22px] font-semibold">{tpl.metadata.name}</h1>
            {templateRef.cluster && <span className="rounded-full bg-foreground px-2 py-0.5 text-[11px] font-bold text-background">{t("Cluster")}</span>}
            {tpl.metadata.labels?.[COMPONENT_LABEL] === "true" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-node-ref-bg px-2 py-0.5 text-[11px] font-semibold text-node-ref">
                <Layers className="size-3" aria-hidden />
                {t("Component")}
              </span>
            )}
            {Object.entries(tpl.metadata.labels ?? {})
              .filter(([k]) => k !== COMPONENT_LABEL && !k.startsWith("workflows.argoproj.io"))
              .map(([k, v]) => (
                <span key={k} className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs">
                  {k}={v}
                </span>
              ))}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-muted-foreground">
            {tpl.metadata.annotations?.[MODIFIED_BY_ANNOTATION] && (
              <span>
                {t("Last modified by")} {tpl.metadata.annotations[MODIFIED_BY_ANNOTATION]}
              </span>
            )}
            <span>
              resourceVersion <Mono>{tpl.metadata.resourceVersion}</Mono>
            </span>
            <span>
              {t("Created")} {formatRelative(tpl.metadata.creationTimestamp)}
            </span>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap gap-2 pb-1">
          {can("template:update") && (
            <Button variant="outline" asChild>
              {editLink}
            </Button>
          )}
          {can("template:delete") && (
            <Button variant="outline" size="icon" className="text-destructive" aria-label={t("Delete template")} onClick={() => setConfirmDelete(true)}>
              <Trash2 aria-hidden />
            </Button>
          )}
          {canSubmit && (
            <Button onClick={() => setSubmitOpen(true)}>
              <Play aria-hidden />
              {t("Submit")}
            </Button>
          )}
        </div>
        <Tabs value={tab} onValueChange={(v) => onTab(v as DetailTab)} className="-mx-4 basis-full sm:-mx-6">
          <TabsList variant="line" className="w-full justify-start gap-5 px-4 sm:px-6">
            <TabsTrigger value="overview">{t("Overview")}</TabsTrigger>
            <TabsTrigger value="runs">{t("Runs")}</TabsTrigger>
            <TabsTrigger value="yaml">YAML</TabsTrigger>
            <TabsTrigger value="revisions">{t("Revisions")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </section>

      {tab === "overview" && <Overview template={tpl} templateRef={templateRef} runNamespace={runNs} onRuns={() => onTab("runs")} />}
      {tab === "runs" && <Runs templateRef={templateRef} namespace={runNs} />}
      {tab === "yaml" && (
        <div className="flex min-h-[520px] flex-1 flex-col gap-2 p-4">
          <p className="text-sm text-muted-foreground">{t("Read-only here; edit in the editor, which keeps your changes as a revision.")}</p>
          <YamlEditor value={toYaml(stripServerFields(tpl))} readOnly path={`tpl-${templateRef.name}.yaml`} className="flex-1 bg-card" />
        </div>
      )}
      {tab === "revisions" && <Revisions templateRef={templateRef} current={tpl} canRollback={can("template:update")} />}

      <SubmitPanel open={submitOpen} onOpenChange={setSubmitOpen} template={tpl} templateRef={templateRef} />
      <ConfirmAction
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("Delete template {{name}}?", { name: tpl.metadata.name })}
        description={t("Runs already created keep running. Grants on this template are revoked with it.")}
        confirmLabel={t("Delete")}
        typeToConfirm={tpl.metadata.name}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

export function stripServerFields(tpl: WorkflowTemplate) {
  const { metadata } = tpl;
  return {
    apiVersion: "argoproj.io/v1alpha1",
    kind: (tpl as { kind?: string }).kind ?? (metadata.namespace ? "WorkflowTemplate" : "ClusterWorkflowTemplate"),
    metadata: { name: metadata.name, namespace: metadata.namespace || undefined, labels: metadata.labels, annotations: metadata.annotations },
    spec: tpl.spec,
  };
}

function Overview({ template, templateRef, runNamespace, onRuns }: { template: WorkflowTemplate; templateRef: TemplateRef; runNamespace: string; onRuns: () => void }) {
  const { t } = useTranslation();
  const spec = template.spec as SpecLike;
  const refs = useMemo(() => referencedTemplates(spec), [spec]);
  const params = template.spec.arguments?.parameters ?? [];
  return (
    <div className="flex flex-col gap-4 p-4 sm:px-6">
      <Section title={t("DAG preview")} description={<span>{t("Entrypoint")} <Mono>{template.spec.entrypoint ?? "—"}</Mono></span>} bodyClassName="h-[300px]">
        <SpecGraphView spec={spec} direction="RIGHT" />
      </Section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t("Parameters")} description="spec.arguments.parameters">
          {params.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t("This template takes no parameters.")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>{t("Name")}</TableHead>
                  <TableHead>{t("Default")}</TableHead>
                  <TableHead>{t("Description")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {params.map((p) => (
                  <TableRow key={p.name}>
                    <TableCell className="font-mono text-[13px]">{p.name}</TableCell>
                    <TableCell className="font-mono text-[13px]">{p.value ?? p.default ?? <span className="text-phase-susp">{t("required")}</span>}</TableCell>
                    <TableCell className="whitespace-normal text-muted-foreground">
                      {p.description ?? ""}
                      {p.enum?.length ? ` (${p.enum.join(" / ")})` : ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
        <Section title={t("Referenced components")} description="templateRef">
          {refs.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t("This template references no other templates.")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>{t("Template")}</TableHead>
                  <TableHead>{t("Scope")}</TableHead>
                  <TableHead>{t("Your access")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {refs.map((r) => (
                  <RefRow key={`${r.clusterScope}/${r.name}`} r={r} namespace={templateRef.cluster ? runNamespace : templateRef.namespace} />
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      </div>
      <Section title={t("Recent runs")} actions={<Button variant="link" size="sm" onClick={onRuns}>{t("All runs")}</Button>}>
        <RunsTable templateRef={templateRef} namespace={runNamespace} limit={5} />
      </Section>
    </div>
  );
}

function RefRow({ r, namespace }: { r: TemplateRefLike; namespace: string }) {
  const { t } = useTranslation();
  const { can, loading } = useActions(r.clusterScope ? { clusterTemplate: r.name } : { namespace, template: r.name });
  return (
    <TableRow>
      <TableCell>
        {r.clusterScope ? (
          <Link to="/cluster-templates/$name" params={{ name: r.name! }} className="font-mono text-[13px] text-primary hover:underline">
            {r.name}
          </Link>
        ) : (
          <Link to="/templates/$namespace/$name" params={{ namespace, name: r.name! }} className="font-mono text-[13px] text-primary hover:underline">
            {r.name}
          </Link>
        )}
        {r.template && <span className="ml-1 font-mono text-xs text-muted-foreground">/ {r.template}</span>}
      </TableCell>
      <TableCell>{r.clusterScope ? t("Cluster") : t("Namespace")}</TableCell>
      <TableCell>{loading ? "…" : can("template:get") ? <span className="text-phase-ok">{t("Readable")}</span> : <span className="text-phase-fail">{t("No access")}</span>}</TableCell>
    </TableRow>
  );
}

function Runs({ templateRef, namespace }: { templateRef: TemplateRef; namespace: string }) {
  return (
    <div className="p-4 sm:px-6">
      <div className="overflow-hidden rounded-xl border bg-card">
        <RunsTable templateRef={templateRef} namespace={namespace} limit={50} />
      </div>
    </div>
  );
}

function RunsTable({ templateRef, namespace, limit }: { templateRef: TemplateRef; namespace: string; limit: number }) {
  const { t } = useTranslation();
  const query = useQuery(workflowQueries.list({ namespace, labelSelector: runLabelSelector(templateRef), limit }));
  const items = query.data?.items ?? [];
  if (query.error) return <ErrorState error={query.error} className="m-4" />;
  if (!query.isPending && !items.length) return <EmptyState title={t("No runs yet")} />;
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[620px]">
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead>{t("Status")}</TableHead>
            <TableHead>{t("Name")}</TableHead>
            <TableHead>{t("Started")}</TableHead>
            <TableHead>{t("Duration")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((wf) => (
            <TableRow key={wf.metadata.uid ?? wf.metadata.name}>
              <TableCell>
                <PhaseBadge phase={wf.status?.phase} suspended={isSuspended(wf)} />
              </TableCell>
              <TableCell>
                <Link to="/workflows/$namespace/$name" params={{ namespace: wf.metadata.namespace, name: wf.metadata.name }} className="font-mono text-[13px] text-primary hover:underline">
                  {wf.metadata.name}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{formatRelative(wf.status?.startedAt ?? wf.metadata.creationTimestamp)}</TableCell>
              <TableCell className="font-mono text-[13px]">{formatDuration(wf.status?.startedAt, wf.status?.finishedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
