// A readable summary of what changed between two template versions (mockup "变更摘要"): tasks and
// templates added, removed or modified, and which of their fields changed.

type Obj = Record<string, unknown>;

export interface Change {
  kind: "added" | "removed" | "modified";
  /** e.g. "task transform" or "template transform". */
  subject: string;
  fields?: string[];
}

const isEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function changedFields(before: Obj, after: Obj, prefix = ""): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: string[] = [];
  for (const k of keys) {
    if (k === "name") continue;
    const a = before?.[k];
    const b = after?.[k];
    if (isEqual(a, b)) continue;
    // Descend one level into plain objects so "resources.limits" reads better than "container".
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b) && prefix === "") {
      const inner = changedFields(a as Obj, b as Obj, `${k}.`);
      out.push(...(inner.length > 3 ? [`${prefix}${k}`] : inner));
    } else out.push(`${prefix}${k}`);
  }
  return out;
}

export function semanticDiff(beforeManifest: Obj, afterManifest: Obj): Change[] {
  const changes: Change[] = [];
  const spec = (m: Obj) => (m?.spec ?? {}) as Obj;
  const templates = (m: Obj) => ((spec(m).templates as Obj[]) ?? []).filter((t) => t?.name);
  const before = new Map(templates(beforeManifest).map((t) => [t.name as string, t]));
  const after = new Map(templates(afterManifest).map((t) => [t.name as string, t]));

  for (const [name, t] of after) {
    const prev = before.get(name);
    if (!prev) {
      changes.push({ kind: "added", subject: `template ${name}` });
      continue;
    }
    // DAG tasks are compared one by one, so editing one task does not read as "template changed".
    const tasks = (x: Obj) => new Map((((x.dag as Obj)?.tasks as Obj[]) ?? []).map((task) => [task.name as string, task]));
    const bt = tasks(prev);
    const at = tasks(t);
    for (const [task, def] of at) {
      if (!bt.has(task)) changes.push({ kind: "added", subject: `task ${task}` });
      else if (!isEqual(bt.get(task), def)) changes.push({ kind: "modified", subject: `task ${task}`, fields: changedFields(bt.get(task)!, def) });
    }
    for (const task of bt.keys()) if (!at.has(task)) changes.push({ kind: "removed", subject: `task ${task}` });
    const strip = (x: Obj) => ({ ...x, dag: x.dag ? { ...(x.dag as Obj), tasks: undefined } : undefined });
    if (!isEqual(strip(prev), strip(t))) changes.push({ kind: "modified", subject: `template ${name}`, fields: changedFields(strip(prev), strip(t)) });
  }
  for (const name of before.keys()) if (!after.has(name)) changes.push({ kind: "removed", subject: `template ${name}` });

  const rest = (m: Obj) => ({ ...spec(m), templates: undefined });
  const specFields = changedFields(rest(beforeManifest), rest(afterManifest));
  if (specFields.length) changes.push({ kind: "modified", subject: "spec", fields: specFields });
  const meta = (m: Obj) => ({ labels: (m.metadata as Obj)?.labels, annotations: (m.metadata as Obj)?.annotations });
  if (!isEqual(meta(beforeManifest), meta(afterManifest))) changes.push({ kind: "modified", subject: "metadata", fields: changedFields(meta(beforeManifest), meta(afterManifest)) });
  return changes;
}
