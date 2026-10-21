import type { Patch } from "immer";
import { Document, isMap, isSeq, parseDocument, YAMLSeq } from "yaml";

// The editor's model is the template's YAML Document (DESIGN §5.4). Every edit is a set of immer
// patches applied to the plain object *and* to the Document, so comments, key order and fields the
// editor does not understand survive every change made from the canvas or the forms.

export type Path = (string | number)[];
export type Json = Record<string, unknown>;

export function parseTemplateYaml(text: string): { doc?: Document; error?: string } {
  const doc = parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length) return { error: doc.errors.map((e) => e.message).join("\n") };
  return { doc };
}

export function docFromObject(obj: unknown): Document {
  return new Document(obj);
}

/** Applies immer patches to a YAML Document in place. */
export function applyPatchesToDoc(doc: Document, patches: Patch[]) {
  for (const p of patches) {
    const path = p.path as Path;
    if (path.length === 0) {
      // A whole-document replacement (YAML edited as text, or a reset): rebuild the contents.
      doc.contents = doc.createNode(p.value) as typeof doc.contents;
      continue;
    }
    switch (p.op) {
      case "replace":
        doc.setIn(path, p.value === undefined ? undefined : doc.createNode(p.value));
        break;
      case "add": {
        const parentPath = path.slice(0, -1);
        const key = path[path.length - 1];
        const parent = parentPath.length ? doc.getIn(parentPath, true) : doc.contents;
        if (isSeq(parent) && typeof key === "number") {
          (parent as YAMLSeq).items.splice(key, 0, doc.createNode(p.value));
        } else if (parent === undefined || parent === null) {
          doc.setIn(path, doc.createNode(p.value));
        } else {
          doc.setIn(path, doc.createNode(p.value));
        }
        break;
      }
      case "remove": {
        const parentPath = path.slice(0, -1);
        const key = path[path.length - 1];
        const parent = parentPath.length ? doc.getIn(parentPath, true) : doc.contents;
        if (isSeq(parent) && typeof key === "number") (parent as YAMLSeq).items.splice(key, 1);
        else if (isMap(parent)) doc.deleteIn(path);
        break;
      }
    }
  }
}

export function getIn(obj: unknown, path: Path): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/**
 * Sets a value inside an immer draft, creating intermediate objects. Setting undefined (or an empty
 * string, array or object) removes the key, so clearing a form field never leaves `field: ""` behind.
 */
export function setIn(draft: unknown, path: Path, value: unknown) {
  if (!path.length) return;
  let cur = draft as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (cur[key] === undefined || cur[key] === null) cur[key] = typeof path[i + 1] === "number" ? [] : {};
    cur = cur[key] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1];
  if (isEmpty(value)) {
    if (Array.isArray(cur) && typeof last === "number") cur.splice(last, 1);
    else delete cur[last];
    pruneEmpty(draft, path.slice(0, -1));
  } else cur[last] = value;
}

function isEmpty(value: unknown) {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

/** Removes parents left empty by a deletion (e.g. `resources: {limits: {}}`). */
function pruneEmpty(draft: unknown, path: Path) {
  for (let depth = path.length; depth > 0; depth--) {
    const parentPath = path.slice(0, depth - 1);
    const key = path[depth - 1];
    const parent = getIn(draft, parentPath) as Record<string | number, unknown> | undefined;
    if (!parent || !isEmpty(parent[key]) || typeof key === "number") return;
    delete parent[key];
  }
}

/** A name not yet used in a list of named things: transform, transform-2, … */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const clean = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
  if (!used.has(clean)) return clean;
  for (let i = 2; ; i++) if (!used.has(`${clean}-${i}`)) return `${clean}-${i}`;
}

// Go serialises zero-valued structs (`inputs: {}`, `metadata: {}`, a container's `name: ""`); they mean
// nothing and would show up in the YAML and in every diff. Only these keys are dropped: an empty
// object is meaningful elsewhere (`suspend: {}`, `emptyDir: {}`).
const ZERO_NOISE = new Set(["inputs", "outputs", "metadata", "arguments", "resources", "securityContext"]);

export function pruneZero(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneZero);
  if (!value || typeof value !== "object") return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    const next = pruneZero(v);
    if (k === "name" && next === "") continue;
    if (ZERO_NOISE.has(k) && next && typeof next === "object" && !Array.isArray(next) && Object.keys(next).length === 0) continue;
    out[k] = next;
  }
  return out;
}
