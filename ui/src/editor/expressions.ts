import type { Component } from "@/api/templates";
import { findTemplate, parseDepends, type SpecLike, type SpecTask, type SpecTemplate } from "@/graph/spec";

export interface Suggestion {
  expr: string;
  hint: string;
}

/** Tasks upstream of `task` in a DAG, transitively. */
export function upstreamOf(dag: SpecTemplate, task: string): Set<string> {
  const tasks = dag.dag?.tasks ?? [];
  const deps = (t?: SpecTask) => (t?.depends ? parseDepends(t.depends).map((d) => d.task) : (t?.dependencies ?? []));
  const out = new Set<string>();
  const visit = (name: string) => {
    for (const d of deps(tasks.find((t) => t.name === name))) {
      if (!out.has(d)) {
        out.add(d);
        visit(d);
      }
    }
  };
  visit(task);
  return out;
}

/** The outputs a task declares: from its template in this spec, or from the referenced component. */
export function declaredOutputs(spec: SpecLike, task: SpecTask, components: Component[]): { parameters: string[]; artifacts: string[]; result: boolean } {
  let tpl: SpecTemplate | undefined = task.inline ?? findTemplate(spec, task.template);
  if (task.templateRef) {
    const comp = components.find((c) => (c.cluster ? c.clusterTemplate : c.template)?.metadata.name === task.templateRef?.name && !!c.cluster === !!task.templateRef?.clusterScope);
    const cs = (comp?.cluster ? comp.clusterTemplate : comp?.template)?.spec as SpecLike | undefined;
    tpl = cs ? findTemplate(cs, task.templateRef.template) : undefined;
  }
  const outputs = (tpl?.outputs ?? {}) as { parameters?: { name: string }[]; artifacts?: { name: string }[] };
  return { parameters: (outputs.parameters ?? []).map((p) => p.name), artifacts: (outputs.artifacts ?? []).map((a) => a.name), result: !!tpl?.script };
}

/** What `{{` can complete to inside a task (DESIGN §3.4). */
export function suggestionsFor(spec: SpecLike, dagName: string | undefined, taskName: string | undefined, components: Component[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const p of ((spec.arguments as { parameters?: { name: string }[] } | undefined)?.parameters ?? [])) out.push({ expr: `workflow.parameters.${p.name}`, hint: "workflow parameter" });
  out.push({ expr: "workflow.name", hint: "workflow" }, { expr: "workflow.namespace", hint: "workflow" }, { expr: "workflow.uid", hint: "workflow" }, { expr: "workflow.creationTimestamp", hint: "workflow" });
  const dag = findTemplate(spec, dagName);
  if (dag) {
    for (const p of ((dag.inputs as { parameters?: { name: string }[] } | undefined)?.parameters ?? [])) out.push({ expr: `inputs.parameters.${p.name}`, hint: `input of ${dag.name}` });
  }
  if (dag?.dag && taskName) {
    const up = upstreamOf(dag, taskName);
    for (const t of dag.dag.tasks ?? []) {
      if (!up.has(t.name)) continue;
      const o = declaredOutputs(spec, t, components);
      for (const p of o.parameters) out.push({ expr: `tasks.${t.name}.outputs.parameters.${p}`, hint: `output of ${t.name} · upstream` });
      for (const a of o.artifacts) out.push({ expr: `tasks.${t.name}.outputs.artifacts.${a}`, hint: `artifact of ${t.name} · upstream` });
      if (o.result) out.push({ expr: `tasks.${t.name}.outputs.result`, hint: `stdout of ${t.name} · upstream` });
      out.push({ expr: `tasks.${t.name}.status`, hint: `status of ${t.name}` });
    }
    out.push({ expr: "item", hint: "the current withItems / withParam element" });
  }
  out.push({ expr: "retries", hint: "attempt number inside a retried template" });
  return out;
}

/**
 * Local semantic checks the server's lint would only catch at run time: an argument that reads the
 * output of a task that is not upstream, or an output the producing template does not declare.
 */
export function referenceProblems(spec: SpecLike, components: Component[]): { template: string; task: string; message: string }[] {
  const problems: { template: string; task: string; message: string }[] = [];
  for (const tpl of spec.templates ?? []) {
    if (!tpl.dag) continue;
    for (const task of tpl.dag.tasks ?? []) {
      const text = JSON.stringify({ arguments: task.arguments, when: task.when, withParam: task.withParam });
      const up = upstreamOf(tpl, task.name);
      for (const m of text.matchAll(/tasks\.([A-Za-z0-9-]+)\.outputs\.(parameters|artifacts)\.([A-Za-z0-9_-]+)/g)) {
        const [, producer, kind, output] = m;
        const p = tpl.dag.tasks?.find((t) => t.name === producer);
        if (!p) {
          problems.push({ template: tpl.name ?? "", task: task.name, message: `references tasks.${producer}, which does not exist` });
          continue;
        }
        if (!up.has(producer)) problems.push({ template: tpl.name ?? "", task: task.name, message: `reads tasks.${producer}.outputs, but ${producer} is not upstream of ${task.name}` });
        const declared = declaredOutputs(spec, p, components);
        const list = kind === "parameters" ? declared.parameters : declared.artifacts;
        const known = p.templateRef ? components.some((c) => (c.cluster ? c.clusterTemplate : c.template)?.metadata.name === p.templateRef?.name) : true;
        if (known && !list.includes(output)) problems.push({ template: tpl.name ?? "", task: task.name, message: `reads tasks.${producer}.outputs.${kind}.${output}, but ${producer} declares ${list.length ? list.join(", ") : `no output ${kind}`}` });
      }
    }
  }
  return problems;
}
