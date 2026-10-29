import { enablePatches, type Patch, produceWithPatches } from "immer";
import type { Document } from "yaml";
import { create } from "zustand";

import { LAYOUT_ANNOTATION, type TemplateScope } from "@/api/templates";
import type { SpecLike } from "@/graph/spec";

import { applyPatchesToDoc, docFromObject, getIn, type Json, parseTemplateYaml, type Path, setIn } from "./doc";

enablePatches();

/** What the config panel is showing. */
export type Selection =
  | { kind: "task"; template: string; id: string }
  | { kind: "exit"; template: string }
  // A template edited on its own, with no task in front of it: a single-step entry template.
  | { kind: "template"; template: string }
  // A lifecycle hook: of a task (template + task) or, with neither, of the workflow (spec.hooks).
  | { kind: "hook"; template?: string; task?: string; event: string }
  | { kind: "workflow" }
  | undefined;

interface Entry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
}

export type Positions = Record<string, Record<string, [number, number]>>;

interface EditorState {
  scope?: TemplateScope;
  /** The manifest as loaded (or last saved) — the merge base when a save conflicts. */
  base?: Json;
  obj: Json;
  doc?: Document;
  /** The YAML tab's text; while it does not parse, the canvas and forms are frozen (DESIGN §3.1). */
  yamlText: string;
  yamlError?: string;
  past: Entry[];
  future: Entry[];
  /** Number of history entries since the last load or save. */
  savedAt: number;
  selection: Selection;
  /** The DAG/steps template shown on the canvas (the entrypoint, or one drilled into). */
  canvasTemplate?: string;

  load: (scope: TemplateScope, manifest: Json, text?: string) => void;
  apply: (label: string, recipe: (draft: Json) => void) => void;
  set: (label: string, path: Path, value: unknown) => void;
  setYaml: (text: string) => void;
  undo: () => void;
  redo: () => void;
  markSaved: (saved: Json) => void;
  select: (selection: Selection) => void;
  openTemplate: (name?: string) => void;
}

function serialize(doc: Document) {
  return doc.toString({ lineWidth: 0 });
}

export const useEditor = create<EditorState>((set, get) => ({
  obj: {},
  yamlText: "",
  past: [],
  future: [],
  savedAt: 0,
  selection: undefined,

  load: (scope, manifest, text) => {
    const parsed = text ? parseTemplateYaml(text) : undefined;
    const doc = parsed?.doc ?? docFromObject(manifest);
    const obj = (parsed?.doc ? parsed.doc.toJS() : manifest) as Json;
    set({ scope, base: structuredClone(obj), obj, doc, yamlText: serialize(doc), yamlError: undefined, past: [], future: [], savedAt: 0, selection: undefined, canvasTemplate: undefined });
  },

  apply: (label, recipe) => {
    const { obj, doc, yamlError, past } = get();
    if (yamlError || !doc) return;
    const [next, patches, inverse] = produceWithPatches(obj, recipe);
    if (!patches.length) return;
    applyPatchesToDoc(doc, patches);
    // Typing into one field produces one history entry per keystroke; merge consecutive edits of the
    // same field so undo steps back a whole value at a time.
    const last = past[past.length - 1];
    const sameField = last && last.label === label && label.startsWith("field:") && patches.length === 1 && last.patches.length === 1 && JSON.stringify(last.patches[0].path) === JSON.stringify(patches[0].path);
    const entry = sameField ? { label, patches, inverse: last.inverse } : { label, patches, inverse };
    set({ obj: next as Json, yamlText: serialize(doc), past: sameField ? [...past.slice(0, -1), entry] : [...past, entry], future: [] });
  },

  set: (label, path, value) => get().apply(label, (draft) => setIn(draft, path, value)),

  setYaml: (text) => {
    const { obj, doc, past } = get();
    const parsed = parseTemplateYaml(text);
    if (!parsed.doc) {
      set({ yamlText: text, yamlError: parsed.error });
      return;
    }
    const next = parsed.doc.toJS() as Json;
    if (JSON.stringify(next) === JSON.stringify(obj)) {
      set({ yamlText: text, yamlError: undefined, doc: parsed.doc });
      return;
    }
    const entry: Entry = { label: "yaml", patches: [{ op: "replace", path: [], value: next }], inverse: [{ op: "replace", path: [], value: obj }] };
    const last = past[past.length - 1];
    set({ obj: next, doc: parsed.doc ?? doc, yamlText: text, yamlError: undefined, past: last?.label === "yaml" ? [...past.slice(0, -1), { ...entry, inverse: last.inverse }] : [...past, entry], future: [] });
  },

  undo: () => {
    const { past, future, obj, doc } = get();
    const entry = past[past.length - 1];
    if (!entry || !doc) return;
    const next = applyTo(obj, entry.inverse);
    applyPatchesToDoc(doc, entry.inverse);
    set({ obj: next, yamlText: serialize(doc), yamlError: undefined, past: past.slice(0, -1), future: [entry, ...future] });
  },

  redo: () => {
    const { past, future, obj, doc } = get();
    const entry = future[0];
    if (!entry || !doc) return;
    const next = applyTo(obj, entry.patches);
    applyPatchesToDoc(doc, entry.patches);
    set({ obj: next, yamlText: serialize(doc), past: [...past, entry], future: future.slice(1) });
  },

  markSaved: (saved) => {
    const { doc } = get();
    // The server returns the stored object; keep our document (and its comments) but adopt the new
    // resourceVersion so the next save is checked against it.
    const rv = getIn(saved, ["metadata", "resourceVersion"]);
    if (doc && rv) doc.setIn(["metadata", "resourceVersion"], rv);
    const obj = { ...get().obj, metadata: { ...(get().obj.metadata as Json), resourceVersion: rv } };
    set({ base: structuredClone(obj), obj, yamlText: doc ? serialize(doc) : get().yamlText, savedAt: get().past.length });
  },

  select: (selection) => set({ selection }),
  openTemplate: (name) => set({ canvasTemplate: name, selection: undefined }),
}));

function applyTo(obj: Json, patches: Patch[]): Json {
  const [next] = produceWithPatches(obj, (draft) => {
    for (const p of patches) {
      if (p.path.length === 0) {
        Object.keys(draft).forEach((k) => delete (draft as Json)[k]);
        Object.assign(draft, structuredClone(p.value));
        continue;
      }
      if (p.op === "remove") {
        const parent = getIn(draft, p.path.slice(0, -1)) as Json | unknown[];
        const key = p.path[p.path.length - 1];
        if (Array.isArray(parent)) parent.splice(key as number, 1);
        else if (parent) delete (parent as Json)[key as string];
      } else if (p.op === "add") {
        const parent = getIn(draft, p.path.slice(0, -1)) as Json | unknown[];
        const key = p.path[p.path.length - 1];
        if (Array.isArray(parent)) parent.splice(key as number, 0, structuredClone(p.value));
        else setIn(draft, p.path as Path, structuredClone(p.value));
      } else setIn(draft, p.path as Path, structuredClone(p.value));
    }
  });
  return next;
}

// ---- selectors and helpers over the template object ----

export const specOf = (obj: Json) => (obj.spec ?? {}) as SpecLike;

export function useSpec() {
  return useEditor((s) => specOf(s.obj));
}

export function useDirty() {
  return useEditor((s) => s.past.length - s.savedAt);
}

/** Index of a template in spec.templates, for building paths. */
export function templateIndex(obj: Json, name: string): number {
  return (specOf(obj).templates ?? []).findIndex((t) => t.name === name);
}

/** Path to a DAG task or a step inside a template. */
export function taskPath(obj: Json, template: string, task: string): Path | undefined {
  const ti = templateIndex(obj, template);
  if (ti < 0) return undefined;
  const t = specOf(obj).templates![ti];
  if (t.dag) {
    const i = (t.dag.tasks ?? []).findIndex((x) => x.name === task);
    return i < 0 ? undefined : ["spec", "templates", ti, "dag", "tasks", i];
  }
  if (t.steps) {
    for (let g = 0; g < t.steps.length; g++) {
      const i = t.steps[g].findIndex((x) => x.name === task);
      if (i >= 0) return ["spec", "templates", ti, "steps", g, i];
    }
  }
  return undefined;
}

export function readLayout(obj: Json): Positions {
  const raw = getIn(obj, ["metadata", "annotations", LAYOUT_ANNOTATION]);
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw) as Positions;
  } catch {
    return {};
  }
}
