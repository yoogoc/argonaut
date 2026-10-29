import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Layers, Search, Settings2, Trash2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { stringify } from "yaml";

import { templateQueries } from "@/api/templates";
import { YamlEditor } from "@/components/common/yaml-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KindIcon, KINDS } from "@/graph/kinds";
import { findTemplate, type NodeKind, type SpecTask, taskKind, templateKind } from "@/graph/spec";
import { useNamespace } from "@/hooks/use-namespace";
import { cn } from "@/lib/utils";

import { getIn, type Path } from "./doc";
import { suggestionsFor } from "./expressions";
import { CodeControl, ExpressionControl, KvListControl, KvMapControl, ListControl, NumberControl, ObjectsControl, ResourcesControl, SelectControl, SwitchControl, TextControl, YamlControl } from "./fields/controls";
import {
  type Base,
  CONTAINER_DEF,
  type FieldDef,
  hookSections,
  ioSections,
  KIND_KEYS,
  kindSections,
  podSections,
  policySections,
  type SectionDef,
  SPEC_DEF,
  STEP_DEF,
  TASK_DEF,
  taskSections,
  TEMPLATE_DEF,
  uncovered,
  workflowTabs,
} from "./fields/registry";
import { deleteHook, type HookOwner, hooksPath, type HookTrigger, hookTrigger, renameHook, renameTask, setHookTarget, setHookTrigger, snapshotRef, type SpecHook } from "./ops";
import { specOf, taskPath, templateIndex, useEditor } from "./store";

interface Bases {
  task?: Path;
  template?: Path;
  container?: Path;
  spec: Path;
}

/**
 * The configuration panel (DESIGN §3.7): six tabs for a node, four for the workflow settings. Every
 * field shows its Argo path and is searchable by name or path; fields bind straight to the document.
 */
export function ConfigPanel() {
  const { t } = useTranslation();
  const selection = useEditor((s) => s.selection);
  const obj = useEditor((s) => s.obj);
  const spec = specOf(obj);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("tpl");
  const [hookTab, setHookTab] = useState("hook");

  if (!selection) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
        <Settings2 className="size-6 opacity-60" aria-hidden />
        <p>{t("Select a node to configure it, or open the workflow settings.")}</p>
        <Button variant="outline" size="sm" onClick={() => useEditor.getState().select({ kind: "workflow" })}>
          {t("Workflow settings")}
        </Button>
      </div>
    );
  }

  if (selection.kind === "workflow") {
    const tabs = workflowTabs();
    const covered = coveredKeys(tabs.flatMap((x) => x.sections), "spec");
    tabs[tabs.length - 1].sections.push({ title: "Other fields", hint: "Every other WorkflowSpec field, from the Argo schema", fields: uncovered(SPEC_DEF, "spec", covered, ["templates", "workflowTemplateRef", "hooks"]) });
    const current = tabs.some((x) => x.id === tab) ? tab : "wbase";
    return (
      <PanelShell icon={<span aria-hidden className="flex size-7 items-center justify-center rounded-[7px] bg-muted"><Settings2 className="size-4" /></span>} title={t("Workflow settings")} subtitle={t("spec-level configuration for the whole template")} query={query} onQuery={setQuery}>
        <Tabs value={current} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
          <TabsList variant="line" className="w-full justify-start gap-4 overflow-x-auto border-b px-5">
            {tabs.map((x) => (
              <TabsTrigger key={x.id} value={x.id}>
                {t(x.label)}
              </TabsTrigger>
            ))}
            <TabsTrigger value="yaml">YAML</TabsTrigger>
          </TabsList>
          {tabs.map((x) => (
            <TabsContent key={x.id} value={x.id} className="min-h-0 flex-1 overflow-auto">
              <Sections sections={x.sections} bases={{ spec: ["spec"] }} query={query} />
            </TabsContent>
          ))}
          <TabsContent value="yaml" className="min-h-0 flex-1 p-4">
            <ReadOnlyYaml value={{ ...spec, templates: undefined }} path="workflow-spec.yaml" />
          </TabsContent>
        </Tabs>
      </PanelShell>
    );
  }

  // A node: a DAG task / step (selection.kind "task"), a lifecycle hook, or the exit handler. A hook has
  // the shape of a task (template or templateRef, arguments), so it is edited through the same bases.
  const hookOwner: HookOwner = selection.kind === "hook" && selection.template && selection.task ? { template: selection.template, task: selection.task } : undefined;
  const hookHolder = selection.kind === "hook" ? hooksPath(obj, hookOwner) : undefined;
  const tPath = selection.kind === "task" ? taskPath(obj, selection.template, selection.id) : selection.kind === "hook" && hookHolder ? [...hookHolder, selection.event] : undefined;
  const task = (tPath ? getIn(obj, tPath) : undefined) as SpecTask | undefined;
  // The exit handler and a single-step entry template are templates edited directly, with no task.
  const exitName = selection.kind === "exit" ? selection.template : undefined;
  const ownName = exitName ?? (selection.kind === "template" ? selection.template : undefined);
  const templateName = ownName ?? task?.template;
  const ti = templateName ? templateIndex(obj, templateName) : -1;
  const tpl = ti >= 0 ? spec.templates![ti] : undefined;
  const kind: NodeKind = ownName ? templateKind(tpl) : task ? taskKind(spec, task) : "unknown";
  const bases: Bases = {
    spec: ["spec"],
    task: tPath,
    template: ti >= 0 ? ["spec", "templates", ti] : undefined,
    container: ti >= 0 && (tpl?.script || tpl?.container) ? ["spec", "templates", ti, tpl.script ? "script" : "container"] : undefined,
  };
  if (selection.kind === "task" && !task) return <p className="p-6 text-sm text-muted-foreground">{t("The selected task no longer exists.")}</p>;
  if (selection.kind === "hook" && !task) return <p className="p-6 text-sm text-muted-foreground">{t("The selected hook no longer exists.")}</p>;

  const isRef = !!task?.templateRef;
  const tabs: { id: string; label: string; sections?: SectionDef[]; note?: string }[] = [];
  if (selection.kind === "hook") {
    tabs.push({ id: "hook", label: "Hook", note: "hook" });
  } else if (task) {
    const sections = taskSections(isRef);
    sections.push({ title: "Other fields", hint: "Every other task field, from the Argo schema", fields: uncovered(isStep(obj, selection) ? STEP_DEF : TASK_DEF, "task", coveredKeys(sections, "task"), ["inline", "hooks"]) });
    tabs.push({ id: "task", label: "Task", sections });
  }
  if (isRef) tabs.push({ id: "tpl", label: KINDS.ref.label, note: "ref" });
  else if (tpl) {
    const all = [...kindSections(kind), ...ioSections(kind), ...arr(podSections(kind)), ...arr(policySections(kind))];
    const covered = coveredKeys(all, "template");
    ["name", "inputs", "outputs", "metadata"].forEach((k) => covered.add(k));
    const kindTab = kindSections(kind);
    if (bases.container) {
      const c = coveredKeys(kindTab, "container");
      kindTab.push({ title: "Other container fields", hint: "Every other container field, from the Kubernetes schema", fields: uncovered(CONTAINER_DEF, "container", c) });
    }
    tabs.push({ id: "tpl", label: `${KINDS[kind].label}`, sections: kindTab });
    tabs.push({ id: "io", label: "Inputs & outputs", sections: ioSections(kind) });
    const pod = podSections(kind);
    tabs.push(Array.isArray(pod) ? { id: "pod", label: "Pod", sections: pod } : { id: "pod", label: "Pod", note: pod.note });
    const policy = policySections(kind);
    if (Array.isArray(policy)) policy.push({ title: "Other fields", hint: "Every other template field, from the Argo schema", fields: uncovered(TEMPLATE_DEF, "template", covered, KIND_KEYS) });
    tabs.push(Array.isArray(policy) ? { id: "policy", label: "Policy", sections: policy } : { id: "policy", label: "Policy", note: policy.note });
  } else if (task?.template) {
    tabs.push({ id: "tpl", label: "Template", note: "missing" });
  }
  tabs.push({ id: "yaml", label: "YAML" });
  // A hook opens on its trigger; switching between hooks keeps whichever tab was chosen for hooks.
  const chosen = selection.kind === "hook" ? hookTab : tab;
  const current = tabs.some((x) => x.id === chosen) ? chosen : tabs.some((x) => x.id === "tpl") ? "tpl" : tabs[0].id;
  const choose = selection.kind === "hook" ? setHookTab : setTab;

  return (
    <PanelShell
      icon={<KindIcon kind={kind} />}
      title={selection.kind === "hook" ? (hookOwner ? `${hookOwner.task} · ${selection.event}` : selection.event) : (task?.name ?? ownName ?? "")}
      subtitle={selection.kind === "hook" ? (hookOwner ? t("Hook on task {{task}}", { task: hookOwner.task }) : t("Workflow hook (spec.hooks)")) : exitName ? t("{{kind}} · exit handler (spec.onExit)", { kind: t(KINDS[kind].label) }) : ownName ? (ownName === spec.entrypoint ? t("{{kind}} · entry template (spec.entrypoint)", { kind: t(KINDS[kind].label) }) : t("{{kind}} · template, used by templateRef", { kind: t(KINDS[kind].label) })) : isRef ? t("Component reference · {{name}}{{scope}}", { name: task?.templateRef?.name, scope: task?.templateRef?.clusterScope ? ` · ${t("cluster")}` : "" }) : t("{{kind}} node · template {{name}}", { kind: t(KINDS[kind].label), name: templateName })}
      query={query}
      onQuery={setQuery}
      actions={selection.kind === "hook" ? (
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          onClick={() => {
            const { apply, select } = useEditor.getState();
            apply("delete hook", (draft) => deleteHook(draft, hookOwner, selection.event));
            select(hookOwner ? { kind: "task", template: hookOwner.template, id: hookOwner.task } : undefined);
          }}
        >
          <Trash2 aria-hidden />
          {t("Delete hook")}
        </Button>
      ) : (kind === "dag" || kind === "steps") && templateName ? <Button variant="outline" size="sm" onClick={() => useEditor.getState().openTemplate(templateName)}>{t("Open on canvas")} <ArrowRight aria-hidden /></Button> : null}
    >
      <Tabs value={current} onValueChange={choose} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList variant="line" className="w-full justify-start gap-4 overflow-x-auto border-b px-5">
          {tabs.map((x) => (
            <TabsTrigger key={x.id} value={x.id}>
              {t(x.label)}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((x) => (
          <TabsContent key={x.id} value={x.id} className="min-h-0 flex-1 overflow-auto">
            {x.id === "yaml" ? (
              <div className="h-full p-4">
                <ReadOnlyYaml value={ownName ? tpl : selection.kind === "hook" ? { hook: task, template: tpl } : { task, template: tpl }} path={`node-${task?.name ?? ownName ?? (selection.kind === "hook" ? selection.event : "")}.yaml`} />
              </div>
            ) : x.note === "hook" ? (
              <HookTab owner={hookOwner} event={selection.kind === "hook" ? selection.event : ""} path={tPath!} />
            ) : x.note === "ref" ? (
              <RefTab task={task!} template={selection.kind === "task" ? selection.template : ""} base={selection.kind === "hook" ? tPath : undefined} />
            ) : x.note === "missing" ? (
              <p className="p-5 text-sm text-destructive">{t("Template {{name}} is not defined in this spec.", { name: task?.template })}</p>
            ) : x.note ? (
              <p className="m-5 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-muted-foreground">{t(x.note)}</p>
            ) : (
              <Sections sections={x.sections!} bases={bases} query={query} taskName={task?.name} dagName={selection.kind === "task" ? selection.template : undefined} />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </PanelShell>
  );
}

function arr<T>(v: T[] | { note: string }): T[] {
  return Array.isArray(v) ? v : [];
}

function isStep(obj: Record<string, unknown>, selection: { kind: string; template?: string }) {
  if (selection.kind !== "task" || !selection.template) return false;
  return !!findTemplate(specOf(obj), selection.template)?.steps;
}

function coveredKeys(sections: SectionDef[], base: Base) {
  const out = new Set<string>();
  for (const s of sections) for (const f of s.fields) if (f.base === base && f.path.length) out.add(String(f.path[0]));
  return out;
}

function PanelShell({ icon, title, subtitle, query, onQuery, actions, children }: { icon: ReactNode; title: string; subtitle: string; query: string; onQuery: (q: string) => void; actions?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-3 border-b-0 px-5 pt-4 pb-3">
        <div className="flex items-center gap-2.5">
          {icon}
          <div className="flex min-w-0 flex-col">
            <h2 className="truncate font-mono text-[15px] font-semibold">{title}</h2>
            <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
          </div>
          {actions && <div className="ml-auto">{actions}</div>}
        </div>
        <label className="relative">
          <span className="sr-only">{t("Search fields")}</span>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder={t("Search fields, e.g. retry, nodeSelector")} className="h-8 bg-muted/40 pl-8 text-xs" />
        </label>
      </div>
      {children}
    </div>
  );
}

function Sections({ sections, bases, query, taskName, dagName }: { sections: SectionDef[]; bases: Bases; query: string; taskName?: string; dagName?: string }) {
  const { t } = useTranslation();
  const q = query.trim().toLowerCase();
  const visible = sections
    .map((s) => ({ ...s, fields: s.fields.filter((f) => !q || t(f.label).toLowerCase().includes(q) || f.label.toLowerCase().includes(q) || f.path.join(".").toLowerCase().includes(q) || t(s.title).toLowerCase().includes(q)) }))
    .filter((s) => s.fields.length);
  if (!visible.length) return <p className="p-5 text-sm text-muted-foreground">{t("No field matches “{{q}}”.", { q: query })}</p>;
  return (
    <>
      {visible.map((s) => (
        <section key={s.title} className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0">
          <div className="flex flex-col gap-0.5">
            <h3 className="text-[13px] font-bold">{t(s.title)}</h3>
            {s.hint && <p className="text-xs leading-relaxed text-muted-foreground">{t(s.hint)}</p>}
          </div>
          {s.fields.map((f) => (
            <Field key={`${f.base}:${f.path.join(".")}:${f.label}`} field={f} bases={bases} taskName={taskName} dagName={dagName} />
          ))}
        </section>
      ))}
    </>
  );
}

function Field({ field, bases, taskName, dagName }: { field: FieldDef; bases: Bases; taskName?: string; dagName?: string }) {
  const { t } = useTranslation();
  const obj = useEditor((s) => s.obj);
  const set = useEditor((s) => s.set);
  const apply = useEditor((s) => s.apply);
  const { namespace } = useNamespace();
  const components = useQuery(templateQueries.components(namespace));
  const base = bases[field.base];
  if (!base) return null;
  const path = [...base, ...field.path];
  const value = getIn(obj, path);
  const write = (v: unknown) => set(`field:${path.join(".")}`, path, v);
  const id = `f-${path.join("-")}`;
  const suggestions = field.control === "expression" || field.control === "kv-list" ? suggestionsFor(specOf(obj), dagName, taskName, components.data ?? []) : [];

  // Renaming a task also rewrites every reference to it, so it is not a plain field write.
  if (field.base === "task" && field.path.join(".") === "name" && dagName && taskName) {
    return (
      <FieldRow label={field.label} path={field.path} id={id}>
        <RenameInput
          value={taskName}
          onCommit={(next) =>
            apply("rename", (draft) => {
              if (renameTask(draft, dagName, taskName, next)) useEditor.setState({ selection: { kind: "task", template: dagName, id: next } });
            })
          }
        />
      </FieldRow>
    );
  }

  let control: ReactNode;
  switch (field.control) {
    case "text":
      control = <TextControl label={t(field.label)} value={value} onChange={write} placeholder={field.placeholder} />;
      break;
    case "number":
      control = <NumberControl label={t(field.label)} value={value} onChange={write} placeholder={field.placeholder} />;
      break;
    case "select":
      control = <SelectControl label={t(field.label)} value={value} onChange={write} options={field.options ?? []} />;
      break;
    case "switch":
      control = <SwitchControl label={t(field.label)} value={value} onChange={write} />;
      break;
    case "expression":
      control = <ExpressionControl label={t(field.label)} value={value} onChange={write} placeholder={field.placeholder} suggestions={suggestions} />;
      break;
    case "list":
      control = <ListControl label={t(field.label)} value={value} onChange={write} />;
      break;
    case "kv-map":
      control = <KvMapControl value={value} onChange={write} />;
      break;
    case "kv-list":
      control = <KvListControl value={value} onChange={write} kv={field.kv ?? ["name", "value"]} suggestions={field.base === "task" ? suggestions : undefined} />;
      break;
    case "objects":
      control = <ObjectsControl value={value} onChange={write} item={field.item} summary={field.summary} />;
      break;
    case "resources":
      control = <ResourcesControl value={value} onChange={write} />;
      break;
    case "code":
      control = <CodeControl value={value} onChange={write} language={field.language === "python" ? languageOf(getIn(obj, [...(bases.container ?? []), "command"])) : field.language} path={`${id}.${field.language ?? "yaml"}`} />;
      break;
    case "yaml":
      control = <YamlControl value={value} onChange={write} placeholder={field.placeholder} path={`${id}.yaml`} />;
      break;
    case "loop":
      control = <LoopControl base={base} />;
      break;
    case "template-ref":
      control = <TemplateRefControl base={path} />;
      break;
    case "note":
      return field.hint ? <p className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground">{t(field.hint)}</p> : null;
  }
  return (
    <FieldRow label={field.label} path={field.path} id={id} hint={field.hint} sub={field.sub}>
      {control}
    </FieldRow>
  );
}

/** The interpreter a script runs with, so its source is highlighted correctly. */
function languageOf(command: unknown): string {
  const first = Array.isArray(command) ? String(command[0] ?? "") : "";
  if (first.includes("python")) return "python";
  if (first.includes("node")) return "javascript";
  if (/(^|\/)(sh|bash|zsh)$/.test(first)) return "shell";
  return "plaintext";
}

function FieldRow({ label, path, id, hint, sub, children }: { label: string; path: Path; id: string; hint?: string; sub?: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5" id={id}>
      {(label || path.length > 0) && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {label && <span className="text-xs font-semibold">{t(label)}</span>}
          {path.length > 0 && <span className="font-mono text-[11px] text-muted-foreground">{path.join(".")}</span>}
        </div>
      )}
      {children}
      {hint && <span className="text-[11px] leading-relaxed text-muted-foreground">{t(hint)}</span>}
      {sub && <span className="text-[11px] leading-relaxed text-muted-foreground">{t(sub)}</span>}
    </div>
  );
}

function RenameInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  return (
    <Input
      value={focused ? draft : value}
      onFocus={() => {
        setDraft(value);
        setFocused(true);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setFocused(false);
        if (draft && draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="h-8 font-mono text-xs"
      aria-label="name"
    />
  );
}

/** withItems / withParam / withSequence: one of the three, chosen explicitly. */
function LoopControl({ base }: { base: Path }) {
  const { t } = useTranslation();
  const obj = useEditor((s) => s.obj);
  const apply = useEditor((s) => s.apply);
  const task = (getIn(obj, base) ?? {}) as SpecTask;
  const mode = task.withItems ? "withItems" : task.withParam !== undefined ? "withParam" : task.withSequence ? "withSequence" : "none";
  const setMode = (next: string) =>
    apply("loop", (draft) => {
      const target = getIn(draft, base) as SpecTask;
      delete target.withItems;
      delete target.withParam;
      delete target.withSequence;
      if (next === "withItems") target.withItems = ["a", "b"];
      if (next === "withParam") target.withParam = "";
      if (next === "withSequence") target.withSequence = { count: "3" };
    });
  const seq = (task.withSequence ?? {}) as Record<string, string>;
  return (
    <div className="space-y-2">
      <SelectControl label={t("Loop")} value={mode === "none" ? undefined : mode} onChange={(v) => setMode((v as string) ?? "none")} options={["withItems", "withParam", "withSequence"]} />
      {mode === "withItems" && <ItemsEditor value={task.withItems ?? []} onChange={(v) => useEditor.getState().set("field:withItems", [...base, "withItems"], v)} />}
      {mode === "withParam" && <ExpressionControl label="withParam" value={task.withParam} onChange={(v) => useEditor.getState().set("field:withParam", [...base, "withParam"], v ?? "")} placeholder="{{tasks.list.outputs.result}}" suggestions={[]} />}
      {mode === "withSequence" && (
        <div className="grid grid-cols-4 gap-1.5">
          {["count", "start", "end", "format"].map((k) => (
            <Input key={k} aria-label={k} placeholder={k} value={seq[k] ?? ""} onChange={(e) => useEditor.getState().set(`field:withSequence.${k}`, [...base, "withSequence", k], e.target.value || undefined)} className="h-8 font-mono text-xs" />
          ))}
        </div>
      )}
    </div>
  );
}

/** withItems may hold scalars (chips) or objects (YAML). */
function ItemsEditor({ value, onChange }: { value: unknown[]; onChange: (v: unknown) => void }) {
  const scalar = value.every((v) => typeof v !== "object");
  if (scalar) return <ListControl label="withItems" value={value} onChange={onChange} />;
  return <YamlControl value={value} onChange={onChange} path="with-items.yaml" />;
}

function TemplateRefControl({ base }: { base: Path }) {
  const { t } = useTranslation();
  const obj = useEditor((s) => s.obj);
  const set = useEditor((s) => s.set);
  const ref = (getIn(obj, base) ?? {}) as { name?: string; template?: string; clusterScope?: boolean };
  return (
    <div className="grid gap-2">
      <TextControl label={t("Template name")} value={ref.name} onChange={(v) => set("field:templateRef.name", [...base, "name"], v)} placeholder="templateRef.name" />
      <TextControl label={t("Entry template")} value={ref.template} onChange={(v) => set("field:templateRef.template", [...base, "template"], v)} placeholder="templateRef.template" />
      <label className="flex items-center gap-2 text-xs">
        <Switch checked={!!ref.clusterScope} onCheckedChange={(v) => set("field:templateRef.clusterScope", [...base, "clusterScope"], v || undefined)} />
        {t("Cluster template")}
      </label>
    </div>
  );
}

const TRIGGERS: { id: HookTrigger; label: string }[] = [
  { id: "running", label: "On start" },
  { id: "succeeded", label: "On success" },
  { id: "failed", label: "On failure" },
  { id: "exit", label: "On finish" },
  { id: "custom", label: "Custom" },
];

/**
 * A hook's own settings: its event name, when it fires (a preset on the owner's status, `exit`, or any
 * expression), what it runs (a template of this spec or a component), and the arguments it passes.
 */
function HookTab({ owner, event, path }: { owner: HookOwner; event: string; path: Path }) {
  const { t } = useTranslation();
  const obj = useEditor((s) => s.obj);
  const apply = useEditor((s) => s.apply);
  const set = useEditor((s) => s.set);
  const { namespace } = useNamespace();
  const components = useQuery(templateQueries.components(namespace));
  const spec = specOf(obj);
  const hook = (getIn(obj, path) ?? {}) as SpecHook;
  const siblings = (getIn(obj, path.slice(0, -1)) ?? {}) as Record<string, SpecHook>;
  const trigger = hookTrigger(obj, owner, event, hook);
  const reselect = (next: string) => next !== event && useEditor.setState({ selection: { kind: "hook", template: owner?.template, task: owner?.task, event: next } });
  const library = components.data ?? [];
  const label = (c: (typeof library)[number]) => `${(c.cluster ? c.clusterTemplate : c.template)?.metadata.name ?? ""}${c.cluster ? ` (${t("cluster")})` : ""}`;
  const refComp = hook.templateRef && library.find((c) => (c.cluster ? c.clusterTemplate : c.template)?.metadata.name === hook.templateRef?.name && !!c.cluster === !!hook.templateRef?.clusterScope);
  const refTemplates = ((refComp ? (refComp.cluster ? refComp.clusterTemplate : refComp.template) : undefined)?.spec.templates ?? []).map((x) => x.name ?? "").filter(Boolean);
  const local = (spec.templates ?? []).map((x) => x.name ?? "").filter((n) => n && n !== owner?.template);
  const target = (next: { template: string } | { templateRef: NonNullable<SpecHook["templateRef"]> }) => apply("hook target", (draft) => setHookTarget(draft, owner, event, next));

  return (
    <div className="flex flex-col">
      <section className="flex flex-col gap-3 border-b px-5 py-4">
        <FieldRow label="Event name" path={[]} id="hook-event" hint="The key under hooks. exit runs when the owner finishes; any other name runs when its expression turns true.">
          <RenameInput value={event} onCommit={(next) => apply("rename hook", (draft) => void (renameHook(draft, owner, event, next) && reselect(next)))} />
        </FieldRow>
        <FieldRow label="Trigger" path={[]} id="hook-trigger">
          <div role="radiogroup" aria-label={t("Trigger")} className="grid grid-cols-5 overflow-hidden rounded-md border text-[11px]">
            {TRIGGERS.map((x) => (
              <button
                key={x.id}
                type="button"
                role="radio"
                aria-checked={trigger === x.id}
                disabled={x.id === "exit" && event !== "exit" && !!siblings.exit}
                onClick={() => {
                  let next = event;
                  apply("hook trigger", (draft) => {
                    next = setHookTrigger(draft, owner, event, x.id);
                  });
                  reselect(next);
                }}
                className={cn("border-r px-1 py-1.5 last:border-r-0 disabled:opacity-40", trigger === x.id ? "bg-primary/10 font-semibold text-primary" : "hover:bg-muted")}
              >
                {t(x.label)}
              </button>
            ))}
          </div>
        </FieldRow>
        {event !== "exit" && (
          <FieldRow label="Expression" path={["expression"]} id="hook-expression" hint="Runs the hook while this is true.">
            <ExpressionControl label="expression" value={hook.expression} onChange={(v) => set("field:hook.expression", [...path, "expression"], v ?? "")} placeholder={`tasks['${owner?.task ?? "x"}'].status == "Running"`} suggestions={suggestionsFor(spec, owner?.template, owner?.task, library)} />
          </FieldRow>
        )}
      </section>
      <section className="flex flex-col gap-3 border-b px-5 py-4">
        <h3 className="text-[13px] font-bold">{t("What it runs")}</h3>
        <div role="radiogroup" aria-label={t("What it runs")} className="grid grid-cols-2 overflow-hidden rounded-md border text-[11px]">
          {(["local", "component"] as const).map((m) => {
            const on = m === "component" ? !!hook.templateRef : !hook.templateRef;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => !on && (m === "local" ? target({ template: local[0] ?? "" }) : target({ templateRef: {} }))}
                className={cn("border-r px-1 py-1.5 last:border-r-0", on ? "bg-primary/10 font-semibold text-primary" : "hover:bg-muted")}
              >
                {m === "local" ? t("A template of this spec") : t("A component")}
              </button>
            );
          })}
        </div>
        {hook.templateRef ? (
          <>
            <FieldRow label="Component" path={["templateRef", "name"]} id="hook-ref-name">
              <SelectControl
                label={t("Component")}
                value={refComp ? label(refComp) : hook.templateRef.name}
                options={library.map(label)}
                onChange={(v) => {
                  const c = library.find((x) => label(x) === v);
                  const tplObj = c && (c.cluster ? c.clusterTemplate : c.template);
                  if (tplObj) target({ templateRef: { name: tplObj.metadata.name, template: tplObj.spec.entrypoint ?? tplObj.spec.templates?.[0]?.name, ...(c.cluster ? { clusterScope: true } : {}) } });
                }}
              />
            </FieldRow>
            <FieldRow label="Template" path={["templateRef", "template"]} id="hook-ref-template">
              <SelectControl label={t("Template")} value={hook.templateRef.template} options={refTemplates} onChange={(v) => set("field:hook.templateRef.template", [...path, "templateRef", "template"], v)} />
            </FieldRow>
          </>
        ) : (
          <FieldRow label="Template" path={["template"]} id="hook-template" hint="Its settings are in the tabs next to this one.">
            <SelectControl label={t("Template")} value={hook.template} options={local} onChange={(v) => target({ template: (v as string) ?? "" })} />
          </FieldRow>
        )}
      </section>
      <Sections sections={hookSections()} bases={{ spec: ["spec"], task: path }} query="" taskName={owner?.task} dagName={owner?.template} />
    </div>
  );
}

/** A component reference: what it points at, its interface, and turning it into a snapshot. */
function RefTab({ task, template, base }: { task: SpecTask; template: string; base?: Path }) {
  const { t } = useTranslation();
  const { namespace } = useNamespace();
  const components = useQuery(templateQueries.components(namespace));
  const apply = useEditor((s) => s.apply);
  const ref = task.templateRef!;
  const comp = (components.data ?? []).find((c) => (c.cluster ? c.clusterTemplate : c.template)?.metadata.name === ref.name && !!c.cluster === !!ref.clusterScope);
  const tpl = comp ? (comp.cluster ? comp.clusterTemplate : comp.template) : undefined;
  const entry = tpl?.spec.templates?.find((x) => x.name === ref.template) as { inputs?: { parameters?: { name: string }[] }; outputs?: { parameters?: { name: string }[]; artifacts?: { name: string }[] } } | undefined;
  return (
    <div className="space-y-4 p-5">
      <div className="space-y-1.5">
        <Label className="text-xs">{t("Reference")}</Label>
        <TemplateRefControl base={[...(base ?? taskPath(useEditor.getState().obj, template, task.name) ?? []), "templateRef"]} />
      </div>
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed">
        {tpl ? (
          <>
            <p className="flex items-center gap-1.5 font-semibold">
              <Layers className="size-3.5" aria-hidden />
              {ref.clusterScope ? t("Cluster component") : t("Component")} <span className="font-mono">{ref.name}</span>
            </p>
            <p className="mt-1 text-muted-foreground">
              {t("Inputs")}: <span className="font-mono">{(entry?.inputs?.parameters ?? []).map((p) => p.name).join(", ") || "—"}</span> · {t("Outputs")}:{" "}
              <span className="font-mono">{[...(entry?.outputs?.parameters ?? []), ...(entry?.outputs?.artifacts ?? [])].map((p) => p.name).join(", ") || "—"}</span>
            </p>
            <p className="mt-1 text-muted-foreground">{t("Its template, pod and policy settings are read-only here. A reference follows the component's updates; a snapshot copies it in and pins this version.")}</p>
          </>
        ) : (
          <p className="text-muted-foreground">{t("This template is not in the component library, or you cannot read it.")}</p>
        )}
      </div>
      {tpl && !base && (
        <Button variant="outline" size="sm" onClick={() => apply("snapshot", (draft) => snapshotRef(draft, template, task.name, tpl, !!comp?.cluster))}>
          {t("Convert to an inline snapshot")}
        </Button>
      )}
    </div>
  );
}

function ReadOnlyYaml({ value, path }: { value: unknown; path: string }) {
  const text = useMemo(() => stringify(value ?? {}, { lineWidth: 0 }), [value]);
  return <YamlEditor value={text} readOnly path={path} className="h-full min-h-[360px]" />;
}
