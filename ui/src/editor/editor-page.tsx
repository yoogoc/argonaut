import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Code2, Eye, Layers, Play, Redo2, Save, ShieldCheck, Undo2, Workflow as WorkflowIcon } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { stringify } from "yaml";

import { useActions } from "@/api/authz";
import { COMPONENT_LABEL, createTemplate, getTemplate, lintTemplate, runLabelSelector, type TemplateRef, type TemplateScope, templateQueries, updateTemplate } from "@/api/templates";
import type { WorkflowTemplate } from "@/api/types";
import { workflowQueries } from "@/api/workflows";
import { ErrorState, errorMessage } from "@/components/common/states";
import { YamlEditor } from "@/components/common/yaml-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useNamespace } from "@/hooks/use-namespace";
import { ApiError, isConflict } from "@/lib/http";
import { cn } from "@/lib/utils";
import { SubmitPanel } from "@/templates/submit-panel";
import { aggregate } from "@/workflow/design-overlay";

import { EditorCanvas } from "./canvas";
import { ConflictView } from "./conflict";
import { type Json, pruneZero } from "./doc";
import { lintLocal, type Problem, problemsByNode, serverProblem } from "./lint";
import { addComponentNode } from "./ops";
import { Palette } from "./palette";
import { ConfigPanel } from "./panel";
import { specOf, useDirty, useEditor } from "./store";

/** What the editor edits: the stored object minus what the server owns. */
function editable(tpl: WorkflowTemplate): Json {
  const { name, namespace, labels, annotations, resourceVersion } = tpl.metadata as WorkflowTemplate["metadata"] & { resourceVersion?: string };
  const metadata: Json = { name };
  if (namespace) metadata.namespace = namespace;
  if (labels && Object.keys(labels).length) metadata.labels = labels;
  if (annotations && Object.keys(annotations).length) metadata.annotations = annotations;
  if (resourceVersion) metadata.resourceVersion = resourceVersion;
  return { metadata, spec: pruneZero(tpl.spec) as Json };
}

function skeleton(scope: TemplateScope, component: boolean): Json {
  const metadata: Json = { name: "" };
  if (!scope.cluster) metadata.namespace = scope.namespace;
  if (component) metadata.labels = { [COMPONENT_LABEL]: "true" };
  return { metadata, spec: { entrypoint: "main", templates: [{ name: "main", dag: { tasks: [] } }] } };
}

/**
 * The template editor (DESIGN §3, mockup "编排器"): palette, canvas and configuration panel over one
 * document. Saving lints against the cluster first, then writes with the resourceVersion the editor
 * loaded; a 409 opens the three-way merge.
 */
export function EditorPage({ scope, name, component = false, from }: { scope: TemplateScope; name?: string; component?: boolean; from?: string }) {
  const { namespace: currentNs } = useNamespace();
  const ref: TemplateRef | undefined = name ? (scope.cluster ? { cluster: true, name } : { cluster: false, namespace: scope.namespace, name }) : undefined;
  const detail = useQuery({ ...templateQueries.detail(ref ?? { cluster: true, name: "" }), enabled: !!ref, staleTime: Infinity, refetchOnWindowFocus: false });
  const [fromScope, fromName] = from?.split("/") ?? [];
  const source = useQuery({
    queryKey: ["templates", "detail", "from", from],
    queryFn: () => getTemplate(fromScope === "cluster" ? { cluster: true, name: fromName } : { cluster: false, namespace: fromScope, name: fromName }),
    enabled: !!from && !name,
    staleTime: Infinity,
  });

  // Load once per template; later refetches must not throw away edits.
  const [loadedKey, setLoadedKey] = useState<string>();
  const key = `${scope.cluster ? "cluster" : scope.namespace}/${name ?? `new:${from ?? ""}:${component}`}`;
  useEffect(() => {
    if (loadedKey === key) return;
    if (name) {
      if (!detail.data) return;
      useEditor.getState().load(scope, editable(detail.data));
    } else {
      if (from && !source.data && !source.error) return;
      const obj = skeleton(scope, component);
      if (source.data) {
        const sourceTpl = source.data;
        (obj.metadata as Json).name = `${sourceTpl.metadata.name}-pipeline`;
        addComponentNode(obj, "main", sourceTpl, fromScope === "cluster", "ref", [0, 0]);
      }
      useEditor.getState().load(scope, obj);
    }
    setLoadedKey(key);
  }, [loadedKey, key, name, detail.data, from, source.data, source.error, scope, component, fromScope]);

  const loaded = loadedKey === key;
  if (detail.error) return <ErrorState error={detail.error} className="m-6" />;
  if (!loaded) return <Skeleton className="m-6 h-[70vh]" />;
  return <Editor scope={scope} templateRef={ref} runNamespace={scope.cluster ? currentNs : scope.namespace} />;
}

function Editor({ scope, templateRef, runNamespace }: { scope: TemplateScope; templateRef?: TemplateRef; runNamespace: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const obj = useEditor((s) => s.obj);
  const yamlText = useEditor((s) => s.yamlText);
  const yamlError = useEditor((s) => s.yamlError);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const canvasTemplate = useEditor((s) => s.canvasTemplate);
  const dirty = useDirty() !== 0 || !templateRef;
  const spec = specOf(obj);
  const metaName = String((obj.metadata as Json | undefined)?.name ?? "");
  const isComponent = ((obj.metadata as Json | undefined)?.labels as Record<string, string> | undefined)?.[COMPONENT_LABEL] === "true";

  const { can } = useActions(templateRef ? (templateRef.cluster ? { clusterTemplate: templateRef.name } : { namespace: templateRef.namespace, template: templateRef.name }) : scope.cluster ? {} : { namespace: scope.namespace });
  const nsActions = useActions({ namespace: runNamespace });
  const canSave = templateRef ? can("template:update") : can("template:create");

  const [view, setView] = useState<"design" | "yaml">("design");
  const [message, setMessage] = useState("");
  const [lintOpen, setLintOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [serverProblems, setServerProblems] = useState<Problem[]>([]);
  const [conflict, setConflict] = useState<{ theirs: Json; mine: Json }>();
  const skipBlock = useRef(false);

  // Local lint runs on every edit, deferred so typing stays responsive.
  const components = useQuery(templateQueries.components(runNamespace));
  const deferred = useDeferredValue(obj);
  const local = useMemo(() => (yamlError ? [] : lintLocal(deferred, !!scope.cluster, components.data ?? [])), [deferred, yamlError, scope.cluster, components.data]);
  useEffect(() => setServerProblems([]), [obj]);
  const problems = useMemo(() => [...(yamlError ? [{ message: yamlError, source: "schema" as const }] : []), ...local, ...serverProblems], [local, serverProblems, yamlError]);
  const byNode = useMemo(() => problemsByNode(spec, problems, canvasTemplate), [spec, problems, canvasTemplate]);

  // The latest run from this template, to colour the canvas (DESIGN §3.5 "设计视图状态叠加").
  const runs = useQuery({ ...workflowQueries.list({ namespace: runNamespace, labelSelector: templateRef ? runLabelSelector(templateRef) : "", limit: 1 }), enabled: overlay && !!templateRef });
  const latest = runs.data?.items?.[0];
  const run = useQuery({ ...workflowQueries.detail(runNamespace, latest?.metadata.name ?? ""), enabled: overlay && !!latest, refetchInterval: 5000 });
  const status = useMemo(() => {
    if (!overlay || !run.data) return undefined;
    const nodes = Object.values(run.data.status?.nodes ?? {});
    return (task: string) => aggregate(nodes.filter((s) => s.type !== "TaskGroup" && s.type !== "StepGroup" && s.type !== "Retry" && (s.displayName === task || s.displayName.startsWith(`${task}(`))));
  }, [overlay, run.data]);

  const toServer = (e: unknown) => {
    if (e instanceof ApiError && e.code === 400) {
      setServerProblems([serverProblem(e.message, spec)]);
      setLintOpen(true);
    }
  };

  const lint = useMutation({
    mutationFn: () => lintTemplate(scope, useEditor.getState().yamlText),
    onSuccess: () => toast.success(t("Argo lint passed")),
    onError: (e) => {
      toServer(e);
      toast.error(errorMessage(e));
    },
  });

  const persist = async (text: string) => {
    await lintTemplate(scope, text);
    return templateRef ? updateTemplate(templateRef, text, message || undefined) : createTemplate(scope, text, message || undefined);
  };
  const onSaved = (saved: WorkflowTemplate) => {
    useEditor.getState().markSaved(saved as unknown as Json);
    setMessage("");
    setConflict(undefined);
    queryClient.setQueryData(templateQueries.detail(templateRef ?? (scope.cluster ? { cluster: true, name: saved.metadata.name } : { cluster: false, namespace: scope.namespace, name: saved.metadata.name })).queryKey, saved);
    void queryClient.invalidateQueries({ queryKey: ["templates", "list"] });
    void queryClient.invalidateQueries({ queryKey: ["templates", "revisions"] });
    toast.success(t("Saved"));
    if (!templateRef) {
      skipBlock.current = true;
      if (scope.cluster) void navigate({ to: "/cluster-templates/$name/edit", params: { name: saved.metadata.name }, replace: true });
      else void navigate({ to: "/templates/$namespace/$name/edit", params: { namespace: scope.namespace, name: saved.metadata.name }, replace: true });
    }
  };

  const save = useMutation({
    mutationFn: () => persist(useEditor.getState().yamlText),
    onSuccess: onSaved,
    onError: async (e) => {
      if (isConflict(e) && templateRef) {
        try {
          const latest = await getTemplate(templateRef);
          setConflict({ theirs: editable(latest), mine: structuredClone(useEditor.getState().obj) });
        } catch (err) {
          toast.error(errorMessage(err));
        }
        return;
      }
      toServer(e);
      toast.error(errorMessage(e));
    },
  });

  const saveMerged = useMutation({
    mutationFn: (merged: Json) => persist(stringify(merged, { lineWidth: 0 })),
    onSuccess: (saved, merged) => {
      // The merge becomes one undoable edit on top of what the user had.
      useEditor.getState().setYaml(stringify(merged, { lineWidth: 0 }));
      onSaved(saved);
    },
    onError: async (e) => {
      if (isConflict(e) && templateRef) {
        toast.error(t("It changed again while you were merging; merging against the latest."));
        const latest = await getTemplate(templateRef);
        setConflict((c) => c && { ...c, theirs: editable(latest) });
        return;
      }
      toServer(e);
      toast.error(errorMessage(e));
    },
  });

  const canSubmitSave = canSave && !yamlError && !!metaName && !save.isPending;
  const trySave = () => !conflict && canSubmitSave && (dirty || !templateRef) && save.mutate();

  // Keyboard: ⌘S saves anywhere; ⌘Z / ⇧⌘Z undo outside text inputs (those keep their own undo).
  const saveRef = useRef(trySave);
  saveRef.current = trySave;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        saveRef.current();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable], .monaco-editor")) return;
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        useEditor.getState().undo();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        useEditor.getState().redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const touched = useDirty() !== 0;
  useBlocker({
    shouldBlockFn: () => {
      if (skipBlock.current) {
        skipBlock.current = false;
        return false;
      }
      return !window.confirm(t("You have unsaved changes. Leave the editor and discard them?"));
    },
    enableBeforeUnload: () => touched,
    disabled: !touched,
  });

  const detailLink = templateRef ? (templateRef.cluster ? { to: "/cluster-templates/$name" as const, params: { name: templateRef.name } } : { to: "/templates/$namespace/$name" as const, params: { namespace: templateRef.namespace, name: templateRef.name } }) : undefined;

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b bg-background px-3 py-2">
        <nav aria-label={t("Breadcrumb")} className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
          <Link to={scope.cluster ? "/cluster-templates" : "/templates"} className="hover:text-foreground">
            {scope.cluster ? t("Cluster templates") : t("Templates")}
          </Link>
          {!scope.cluster && (
            <>
              <span aria-hidden>/</span>
              <span className="font-mono">{scope.namespace}</span>
            </>
          )}
          <span aria-hidden>/</span>
        </nav>
        {templateRef ? (
          detailLink && (
            <Link {...detailLink} className="font-mono text-[15px] font-semibold hover:underline">
              {templateRef.name}
            </Link>
          )
        ) : (
          <label className="flex items-center gap-1.5">
            <span className="sr-only">{t("Template name")}</span>
            <Input
              autoFocus
              value={metaName}
              onChange={(e) => useEditor.getState().set("field:name", ["metadata", "name"], e.target.value)}
              placeholder={t("template-name")}
              aria-invalid={!metaName}
              className="h-8 w-56 font-mono text-sm"
            />
          </label>
        )}
        {isComponent && (
          <span className="inline-flex items-center gap-1 rounded-full bg-node-ref-bg px-2 py-0.5 text-[11px] font-semibold text-node-ref">
            <Layers className="size-3" aria-hidden />
            {t("Component")}
          </span>
        )}
        {touched && <span className="text-xs text-muted-foreground">{t("Unsaved changes")}</span>}

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button variant="ghost" size="icon" className="size-8" disabled={!canUndo} onClick={() => useEditor.getState().undo()} aria-label={t("Undo")} title={`${t("Undo")} (⌘Z)`}>
            <Undo2 aria-hidden />
          </Button>
          <Button variant="ghost" size="icon" className="size-8" disabled={!canRedo} onClick={() => useEditor.getState().redo()} aria-label={t("Redo")} title={`${t("Redo")} (⇧⌘Z)`}>
            <Redo2 aria-hidden />
          </Button>
          <ToggleGroup type="single" size="sm" variant="outline" value={view} onValueChange={(v) => v && setView(v as "design" | "yaml")}>
            <ToggleGroupItem value="design" className="h-8 px-2.5 text-xs">
              <WorkflowIcon aria-hidden />
              {t("Design")}
            </ToggleGroupItem>
            <ToggleGroupItem value="yaml" className="h-8 px-2.5 text-xs">
              <Code2 aria-hidden />
              YAML
            </ToggleGroupItem>
          </ToggleGroup>
          {templateRef && (
            <Button variant={overlay ? "secondary" : "outline"} size="sm" aria-pressed={overlay} onClick={() => setOverlay((o) => !o)} title={t("Colour the canvas by the latest run of this template")}>
              <Eye aria-hidden />
              {overlay ? (latest ? latest.metadata.name : runs.isPending ? t("Loading…") : t("No runs yet")) : t("Latest run")}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => lint.mutate()} disabled={lint.isPending || !!yamlError}>
            <ShieldCheck aria-hidden />
            {t("Lint")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSubmitOpen(true)}
            disabled={!templateRef || touched || !nsActions.can("workflow:submit")}
            title={!templateRef || touched ? t("Save before running") : undefined}
          >
            <Play aria-hidden />
            {t("Run")}
          </Button>
          <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t("Change note (optional)")} className="h-8 w-48 text-xs" aria-label={t("Change note")} />
          {!conflict && (
            <Button size="sm" onClick={trySave} disabled={!canSubmitSave || (!touched && !!templateRef)} title={!canSave ? t("You cannot save this template") : `${t("Lint and save")} (⌘S)`}>
              <Save aria-hidden />
              {save.isPending ? t("Saving…") : t("Save")}
            </Button>
          )}
        </div>
      </header>

      {conflict ? (
        <ConflictView base={useEditor.getState().base ?? {}} theirs={conflict.theirs} mine={conflict.mine} saving={saveMerged.isPending} onSave={(m) => saveMerged.mutate(m)} onCancel={() => setConflict(undefined)} />
      ) : (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="16" minSize={180} className="min-h-0">
            <Palette namespace={runNamespace} />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="54" minSize={320} className="flex min-h-0 flex-col">
            <div className="relative min-h-0 flex-1 bg-canvas">
              {view === "design" ? (
                <EditorCanvas problems={byNode} status={status} />
              ) : (
                <div className="absolute inset-0 p-2">
                  <YamlEditor value={yamlText} onChange={(v) => useEditor.getState().setYaml(v)} path="editor-full.yaml" className="h-full bg-background" />
                </div>
              )}
            </div>
            <LintStrip problems={problems} open={lintOpen} onOpen={setLintOpen} running={lint.isPending} />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="30" minSize={300} className="min-h-0 border-l bg-card">
            <ConfigPanel />
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      {submitOpen && templateRef && <SubmitPanel open={submitOpen} onOpenChange={setSubmitOpen} template={obj as unknown as WorkflowTemplate} templateRef={templateRef} />}
    </div>
  );
}

/** The problems list under the canvas (DESIGN §5.4): click one to select its node. */
function LintStrip({ problems, open, onOpen, running }: { problems: Problem[]; open: boolean; onOpen: (open: boolean) => void; running: boolean }) {
  const { t } = useTranslation();
  const select = (p: Problem) => {
    const { obj, openTemplate, select } = useEditor.getState();
    if (!p.node) return select({ kind: "workflow" });
    if (p.node.startsWith("exit:")) return select({ kind: "exit", template: p.node.slice(5) });
    if (p.node.startsWith("template:")) return;
    const owner = p.template ?? specOf(obj).entrypoint;
    if (owner && owner !== specOf(obj).entrypoint) openTemplate(owner);
    if (owner) select({ kind: "task", template: owner, id: p.node });
  };
  return (
    <section aria-label={t("Problems")} className="border-t bg-background">
      <button type="button" onClick={() => onOpen(!open)} className="flex w-full items-center gap-2 px-3 py-1.5 text-xs" aria-expanded={open}>
        {problems.length ? <AlertCircle className="size-3.5 text-phase-fail" aria-hidden /> : <CheckCircle2 className="size-3.5 text-phase-ok" aria-hidden />}
        <span className={cn("font-semibold", problems.length ? "text-phase-fail" : "text-phase-ok")}>{running ? t("Linting…") : problems.length ? t("{{count}} problems", { count: problems.length }) : t("No problems")}</span>
        <span className="ml-auto text-muted-foreground">{open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronUp className="size-3.5" aria-hidden />}</span>
      </button>
      {open && problems.length > 0 && (
        <ul className="max-h-40 overflow-auto border-t">
          {problems.map((p, i) => (
            <li key={i}>
              <button type="button" onClick={() => select(p)} className="flex w-full items-baseline gap-2 px-3 py-1 text-left text-xs hover:bg-accent">
                <span className="w-16 shrink-0 text-muted-foreground">{t(p.source)}</span>
                {p.node && <span className="shrink-0 font-mono font-semibold">{p.node.replace(/^template:/, "")}</span>}
                <span className="min-w-0 flex-1">{p.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
