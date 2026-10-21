import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { parse, stringify } from "yaml";

import { YamlEditor } from "@/components/common/yaml-editor";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import type { Suggestion } from "../expressions";

const UNSET = "__unset__";
const toYaml = (v: unknown) => (v === undefined ? "" : stringify(v, { lineWidth: 0 }));

export function TextControl({ value, onChange, placeholder, label }: { value: unknown; onChange: (v: unknown) => void; placeholder?: string; label: string }) {
  const { t } = useTranslation();
  return <Input aria-label={label} value={value === undefined || value === null ? "" : String(value)} placeholder={placeholder ? t(placeholder) : t("not set")} onChange={(e) => onChange(e.target.value)} className="h-8 font-mono text-xs" />;
}

export function NumberControl({ value, onChange, placeholder, label }: { value: unknown; onChange: (v: unknown) => void; placeholder?: string; label: string }) {
  const { t } = useTranslation();
  return (
    <Input
      aria-label={label}
      inputMode="numeric"
      value={value === undefined || value === null ? "" : String(value)}
      placeholder={placeholder ? t(placeholder) : t("not set")}
      onChange={(e) => {
        const raw = e.target.value.trim();
        if (raw === "") return onChange(undefined);
        const n = Number(raw);
        onChange(Number.isFinite(n) ? n : raw);
      }}
      className="h-8 font-mono text-xs"
    />
  );
}

export function SelectControl({ value, onChange, options, label }: { value: unknown; onChange: (v: unknown) => void; options: string[]; label: string }) {
  const { t } = useTranslation();
  return (
    <Select value={value === undefined ? UNSET : String(value)} onValueChange={(v) => onChange(v === UNSET ? undefined : v)}>
      <SelectTrigger size="sm" aria-label={label} className="w-full font-mono text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNSET} className="text-muted-foreground">
          {t("not set")}
        </SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o} className="font-mono text-xs">
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function SwitchControl({ value, onChange, label }: { value: unknown; onChange: (v: unknown) => void; label: string }) {
  const { t } = useTranslation();
  const on = value === true;
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <Switch checked={on} onCheckedChange={(v) => onChange(v ? true : undefined)} aria-label={label} />
      {value === false ? t("false (explicitly)") : on ? t("on") : t("off")}
    </label>
  );
}

/**
 * A text input that completes `{{…}}` expressions (DESIGN §3.4): typing `{{` opens the list of
 * workflow parameters, inputs and upstream task outputs.
 */
export function ExpressionControl({ value, onChange, placeholder, label, suggestions }: { value: unknown; onChange: (v: unknown) => void; placeholder?: string; label: string; suggestions: Suggestion[] }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [needle, setNeedle] = useState("");
  const text = value === undefined || value === null ? "" : String(value);

  const detect = (next: string, caret: number) => {
    const m = next.slice(0, caret).match(/\{\{\s*([\w.-]*)$/);
    setOpen(!!m);
    setNeedle(m?.[1] ?? "");
  };
  const choose = (expr: string) => {
    const el = input.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/\{\{\s*[\w.-]*$/, `{{${expr}}}`);
    const after = text.slice(caret).replace(/^[\w.-]*\s*\}\}/, "");
    onChange(before + after);
    setOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    });
  };
  const shown = suggestions.filter((s) => s.expr.toLowerCase().includes(needle.toLowerCase())).slice(0, 30);

  return (
    <Popover open={open && shown.length > 0} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Input
          ref={input}
          aria-label={label}
          value={text}
          placeholder={placeholder ? t(placeholder) : t("not set")}
          className="h-8 font-mono text-xs"
          onChange={(e) => {
            onChange(e.target.value);
            detect(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        />
      </PopoverAnchor>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-80 p-0" align="start" onOpenAutoFocus={(e) => e.preventDefault()}>
        <Command shouldFilter={false}>
          <CommandList>
            <CommandEmpty>{t("No suggestions")}</CommandEmpty>
            <CommandGroup heading={t("Expressions")}>
              {shown.map((s) => (
                <CommandItem key={s.expr} value={s.expr} onSelect={() => choose(s.expr)} className="flex flex-col items-start gap-0">
                  <span className="font-mono text-xs">{`{{${s.expr}}}`}</span>
                  <span className="text-[11px] text-muted-foreground">{t(s.hint)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** A list of strings: command, args, flags, withItems of scalars. */
export function ListControl({ value, onChange, label }: { value: unknown; onChange: (v: unknown) => void; label: string }) {
  const { t } = useTranslation();
  const items = Array.isArray(value) ? (value as unknown[]) : [];
  const [draft, setDraft] = useState("");
  const add = () => {
    if (!draft.trim()) return;
    onChange([...items, draft]);
    setDraft("");
  };
  return (
    <div className="space-y-1.5">
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            <span key={i} className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted py-0.5 pr-1 pl-2 font-mono text-xs">
              <span className="truncate">{typeof item === "string" ? item : JSON.stringify(item)}</span>
              <button type="button" aria-label={t("Remove {{item}}", { item: String(item) })} onClick={() => onChange(items.filter((_, j) => j !== i))} className="rounded p-0.5 hover:bg-background">
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <Input
          aria-label={t("Add to {{label}}", { label })}
          value={draft}
          placeholder={t("Add, then Enter")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          className="h-8 font-mono text-xs"
        />
        <Button type="button" variant="outline" size="sm" className="h-8" onClick={add} aria-label={t("Add")}>
          <Plus aria-hidden />
        </Button>
      </div>
    </div>
  );
}

/** A string map: labels, annotations, nodeSelector. */
export function KvMapControl({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useTranslation();
  const entries = Object.entries((value ?? {}) as Record<string, string>);
  const write = (next: [string, string][]) => onChange(Object.fromEntries(next.filter(([k]) => k !== "")));
  return (
    <div className="space-y-1.5">
      {entries.map(([k, v], i) => (
        <div key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-1.5">
          <Input aria-label={t("Key")} value={k} onChange={(e) => write(entries.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} className="h-8 font-mono text-xs" />
          <Input aria-label={t("Value")} value={v ?? ""} onChange={(e) => write(entries.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} className="h-8 font-mono text-xs" />
          <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t("Remove {{item}}", { item: k })} onClick={() => write(entries.filter((_, j) => j !== i))}>
            <Trash2 aria-hidden />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="h-7 border-dashed text-xs" onClick={() => onChange({ ...Object.fromEntries(entries), [`key${entries.length + 1}`]: "" })}>
        <Plus aria-hidden />
        {t("Add")}
      </Button>
    </div>
  );
}

/** A list of {name, value} items (env, parameters, headers). Items using valueFrom open as YAML. */
export function KvListControl({ value, onChange, kv, suggestions }: { value: unknown; onChange: (v: unknown) => void; kv: [string, string]; suggestions?: Suggestion[] }) {
  const { t } = useTranslation();
  const items = (Array.isArray(value) ? value : []) as Record<string, unknown>[];
  const [editing, setEditing] = useState<number>();
  const [k, v] = kv;
  const update = (i: number, patch: Record<string, unknown>) => onChange(items.map((item, j) => (j === i ? { ...item, ...patch } : item)));
  return (
    <div className="space-y-1.5">
      {items.map((item, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-1.5">
          <Input aria-label={t(k)} value={String(item[k] ?? "")} onChange={(e) => update(i, { [k]: e.target.value })} className="h-8 font-mono text-xs" />
          {item[v] === undefined && Object.keys(item).some((key) => key !== k) ? (
            <button type="button" onClick={() => setEditing(i)} className="h-8 truncate rounded-md border border-dashed px-2 text-left font-mono text-xs text-muted-foreground hover:bg-accent">
              {Object.keys(item)
                .filter((key) => key !== k)
                .map((key) => `${key}: ${typeof item[key] === "object" ? Object.keys(item[key] as object).join(", ") : String(item[key])}`)
                .join(" · ")}
            </button>
          ) : suggestions ? (
            <ExpressionControl label={t(v)} value={item[v]} onChange={(val) => update(i, { [v]: val })} suggestions={suggestions} />
          ) : (
            <Input aria-label={t(v)} value={String(item[v] ?? "")} onChange={(e) => update(i, { [v]: e.target.value })} className="h-8 font-mono text-xs" />
          )}
          <div className="flex">
            <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t("Edit as YAML")} onClick={() => setEditing(i)}>
              <Pencil aria-hidden />
            </Button>
            <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t("Remove")} onClick={() => onChange(items.filter((_, j) => j !== i))}>
              <Trash2 aria-hidden />
            </Button>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="h-7 border-dashed text-xs" onClick={() => onChange([...items, { [k]: "", [v]: "" }])}>
        <Plus aria-hidden />
        {t("Add")}
      </Button>
      <ItemDialog open={editing !== undefined} value={editing !== undefined ? items[editing] : undefined} onClose={() => setEditing(undefined)} onSave={(next) => onChange(items.map((item, j) => (j === editing ? next : item)))} />
    </div>
  );
}

/** A list of objects shown as one-line summaries; each item is edited as YAML (all sub-fields). */
export function ObjectsControl({ value, onChange, item, summary }: { value: unknown; onChange: (v: unknown) => void; item?: unknown; summary?: (i: Record<string, unknown>) => string }) {
  const { t } = useTranslation();
  const items = (Array.isArray(value) ? value : []) as Record<string, unknown>[];
  const [editing, setEditing] = useState<number>();
  return (
    <div className="space-y-1.5">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs">
          <span className="min-w-0 flex-1 truncate font-mono">{summary ? summary(it) : JSON.stringify(it)}</span>
          <button type="button" className="text-primary hover:underline" onClick={() => setEditing(i)}>
            {t("Edit")}
          </button>
          <button type="button" aria-label={t("Remove")} className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 border-dashed text-xs"
        onClick={() => {
          onChange([...items, structuredClone(item ?? {})]);
          setEditing(items.length);
        }}
      >
        <Plus aria-hidden />
        {t("Add")}
      </Button>
      <ItemDialog open={editing !== undefined} value={editing !== undefined ? items[editing] : undefined} onClose={() => setEditing(undefined)} onSave={(next) => onChange(items.map((it, j) => (j === editing ? next : it)))} />
    </div>
  );
}

function ItemDialog({ open, value, onClose, onSave }: { open: boolean; value: unknown; onClose: () => void; onSave: (v: Record<string, unknown>) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) {
      setText(toYaml(value));
      setError(undefined);
    }
  }, [open, value]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[min(70vh,560px)] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("Edit item")}</DialogTitle>
        </DialogHeader>
        {error && <p className="font-mono text-xs text-destructive">{error}</p>}
        <YamlEditor value={text} onChange={setText} className="min-h-0 flex-1" path="item.yaml" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            onClick={() => {
              try {
                const parsed = parse(text);
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(t("An item is a YAML mapping."));
                onSave(parsed as Record<string, unknown>);
                onClose();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            {t("Apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const RESOURCE_KEYS = ["cpu", "memory", "nvidia.com/gpu", "ephemeral-storage"];

export function ResourcesControl({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const res = (value ?? {}) as { requests?: Record<string, string>; limits?: Record<string, string> };
  const write = (kind: "requests" | "limits", key: string, v: string) => {
    const next = { ...res, [kind]: { ...(res[kind] ?? {}), [key]: v } };
    if (!v) delete next[kind]![key];
    if (!Object.keys(next[kind]!).length) delete next[kind];
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[64px_repeat(4,minmax(0,1fr))] gap-1.5 text-[11px] text-muted-foreground">
        <span />
        {RESOURCE_KEYS.map((k) => (
          <span key={k} className="truncate font-mono">
            {k}
          </span>
        ))}
      </div>
      {(["requests", "limits"] as const).map((kind) => (
        <div key={kind} className="grid grid-cols-[64px_repeat(4,minmax(0,1fr))] items-center gap-1.5">
          <span className="font-mono text-[11px] text-muted-foreground">{kind}</span>
          {RESOURCE_KEYS.map((k) => (
            <Input key={k} aria-label={`${kind} ${k}`} value={res[kind]?.[k] ?? ""} placeholder="—" onChange={(e) => write(kind, k, e.target.value)} className="h-8 px-2 font-mono text-xs" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A code field (script source, manifest, body): a compact Monaco editor. */
export function CodeControl({ value, onChange, language = "yaml", path }: { value: unknown; onChange: (v: unknown) => void; language?: string; path: string }) {
  return <YamlEditor value={typeof value === "string" ? value : ""} onChange={(v) => onChange(v || undefined)} language={language} path={path} className="h-48 min-h-48" />;
}

/**
 * Any object-valued field without a dedicated control: edited as YAML, written back once it parses.
 * Collapsed until opened, so a section of rarely-used fields stays short.
 */
export function YamlControl({ value, onChange, placeholder, path }: { value: unknown; onChange: (v: unknown) => void; placeholder?: string; path: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => toYaml(value));
  const [error, setError] = useState<string>();
  const external = useMemo(() => toYaml(value), [value]);
  useEffect(() => {
    if (!open) setText(external);
  }, [external, open]);
  if (!open && value === undefined) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="w-full rounded-md border border-dashed px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent">
        {t("Not set · click to edit as YAML")}
      </button>
    );
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="block w-full rounded-md bg-zinc-950 px-3 py-2 text-left font-mono text-xs whitespace-pre text-zinc-200 hover:ring-2 hover:ring-ring/40">
        {external.trimEnd()}
      </button>
    );
  }
  return (
    <div className="space-y-1.5">
      <YamlEditor
        value={text || placeholder || ""}
        path={path}
        className="h-40 min-h-40"
        onChange={(next) => {
          setText(next);
          try {
            const parsed = next.trim() ? parse(next) : undefined;
            setError(undefined);
            onChange(parsed);
          } catch (e) {
            setError(e instanceof Error ? e.message.split("\n")[0] : String(e));
          }
        }}
      />
      <div className="flex items-center gap-2">
        {error && <span className="truncate font-mono text-[11px] text-destructive">{error}</span>}
        <Button type="button" variant="ghost" size="sm" className={cn("ml-auto h-7 text-xs")} onClick={() => setOpen(false)}>
          {t("Done")}
        </Button>
      </div>
    </div>
  );
}
