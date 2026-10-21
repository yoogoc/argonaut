// Three-way merge of template manifests for the save-conflict view (DESIGN §3.5). The merge is
// structural rather than textual: maps merge key by key, and lists of named items (templates, tasks,
// parameters, env…) merge by name, so two people editing different tasks never conflict even when
// their edits are a line apart in the YAML.

export type Value = unknown;
export type Path = (string | number)[];

export interface Conflict {
  path: Path;
  /** A readable location: "task transform · retryStrategy.limit". */
  label: string;
  base: Value;
  theirs: Value;
  mine: Value;
}

export interface AutoChange {
  path: Path;
  label: string;
  who: "mine" | "theirs";
}

export interface MergeResult {
  merged: Value;
  conflicts: Conflict[];
  changes: AutoChange[];
}

// Fields owned by the server or by argonaut, never a user's conflict.
const IGNORED = new Set(["resourceVersion", "generation", "uid", "creationTimestamp", "managedFields", "argonaut.io/last-modified-by", "argonaut.io/layout"]);
const eq = (a: Value, b: Value) => JSON.stringify(a, skipIgnored) === JSON.stringify(b, skipIgnored);
function skipIgnored(key: string, value: Value) {
  return IGNORED.has(key) ? undefined : value;
}
const isObj = (v: Value): v is Record<string, Value> => !!v && typeof v === "object" && !Array.isArray(v);
const named = (v: Value): v is Record<string, Value>[] => Array.isArray(v) && v.length > 0 && v.every((x) => isObj(x) && typeof x.name === "string");

/** The innermost places where `from` and `to` differ, so a change is reported as "container.image", not "template echo". */
function differences(from: Value, to: Value, path: Path, out: Path[]) {
  if (eq(from, to)) return;
  if (isObj(from) && isObj(to)) {
    for (const k of new Set([...Object.keys(from), ...Object.keys(to)])) if (!IGNORED.has(k)) differences(from[k], to[k], [...path, k], out);
    return;
  }
  if (named(from) && named(to)) {
    const byName = new Map(from.map((x) => [x.name, x]));
    // Positions are those in `to`, which is what the merge keeps for this side.
    to.forEach((x, i) => differences(byName.get(x.name), x, [...path, i], out));
    if (from.some((x) => !to.some((y) => y.name === x.name))) out.push(path);
    return;
  }
  out.push(path);
}

/** Turns a path into "task transform · retryStrategy.limit" using the names along the way. */
export function describe(path: Path, root: Value): string {
  const parts: string[] = [];
  let cur: Value = root;
  let tail: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    const next: Value = isObj(cur) || Array.isArray(cur) ? (cur as Record<string | number, Value>)[key] : undefined;
    if (typeof key === "number" && isObj(next) && typeof next.name === "string") {
      const kind = path[i - 1] === "tasks" ? "task" : path[i - 1] === "templates" ? "template" : String(path[i - 1] ?? "item").replace(/s$/, "");
      if (kind === "task" || kind === "template") {
        parts.push(`${kind} ${next.name}`);
        tail = [];
      } else tail.push(`${kind}[${next.name}]`);
    } else if (typeof key === "string" && !["spec", "dag", "tasks", "templates"].includes(key)) tail.push(key);
    cur = next;
  }
  return [...parts, tail.join(".")].filter(Boolean).join(" · ") || "spec";
}

export function merge3(base: Value, theirs: Value, mine: Value): MergeResult {
  const conflicts: Conflict[] = [];
  const changes: AutoChange[] = [];

  const walk = (b: Value, t: Value, m: Value, path: Path): Value => {
    const key = path[path.length - 1];
    // Node positions are presentation: keep the editor's own layout over theirs.
    if (key === "argonaut.io/layout") return m ?? t;
    if (typeof key === "string" && IGNORED.has(key)) return t;
    if (eq(m, t)) return m;
    if (eq(m, b)) {
      for (const p of leaves(b, t, path)) changes.push({ path: p, label: "", who: "theirs" });
      return t;
    }
    if (eq(t, b)) {
      for (const p of leaves(b, m, path)) changes.push({ path: p, label: "", who: "mine" });
      return m;
    }
    if (isObj(b ?? {}) && isObj(t) && isObj(m)) {
      const bo = (isObj(b) ? b : {}) as Record<string, Value>;
      const out: Record<string, Value> = {};
      const keys = [...new Set([...Object.keys(bo), ...Object.keys(t), ...Object.keys(m)])];
      for (const k of keys) {
        const v = walk(bo[k], t[k], m[k], [...path, k]);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    if ((named(t) || named(m)) && Array.isArray(t) && Array.isArray(m)) {
      const by = (arr: Value) => new Map((Array.isArray(arr) ? arr : []).filter(isObj).map((x) => [String(x.name), x]));
      const bm = by(b);
      const tm = by(t);
      const mm = by(m);
      // Keep their order, then append items only I added, in my order.
      const order = [...tm.keys(), ...[...mm.keys()].filter((k) => !tm.has(k))];
      const out: Value[] = [];
      // Paths are positions in the merged list, so a resolution can be written back by path.
      for (const name of order) {
        const v = walk(bm.get(name), tm.get(name), mm.get(name), [...path, out.length]);
        if (v !== undefined) out.push(v);
      }
      return out;
    }
    conflicts.push({ path, label: "", base: b, theirs: t, mine: m });
    return m;
  };

  // A side's own positions differ from the merged ones only for lists merged by name above this
  // point, and those are walked item by item, so the leaf paths line up with the merged result.
  const leaves = (from: Value, to: Value, path: Path) => {
    const out: Path[] = [];
    differences(from, to, path, out);
    return out.length ? out : [path];
  };

  const merged = walk(base, theirs, mine, []);
  // The save goes against their version: carry over what the server owns.
  if (isObj(merged) && isObj(merged.metadata) && isObj(theirs) && isObj(theirs.metadata)) {
    for (const k of ["resourceVersion", "generation", "uid", "creationTimestamp"]) {
      if (theirs.metadata[k] !== undefined) merged.metadata[k] = theirs.metadata[k];
    }
  }
  // Labels are read off the merged result, whose list positions the paths refer to.
  for (const c of conflicts) c.label = describe(c.path, merged);
  for (const c of changes) c.label = describe(c.path, merged);
  return { merged, conflicts, changes };
}

/** Writes a resolution into the merged object at a conflict's path (mine-indexed). */
export function resolveAt(merged: Value, path: Path, value: Value): Value {
  const copy = structuredClone(merged) as Record<string | number, Value>;
  let cur = copy;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]] as Record<string | number, Value>;
  const last = path[path.length - 1];
  if (value === undefined) {
    if (Array.isArray(cur)) cur.splice(last as number, 1);
    else delete cur[last];
  } else cur[last] = value;
  return copy;
}
