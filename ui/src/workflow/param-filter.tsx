import { SlidersHorizontal, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";

/**
 * Filters runs by parameter. Each term is its own chip, so a value may contain commas or spaces:
 * "name=value" matches exactly, "name~text" by case-insensitive substring, a bare "name" when present.
 */
export function ParamFilter({ value, onChange }: { value: string[]; onChange: (terms: string[]) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const invalid = /^\s*[=~]/.test(draft);

  const add = () => {
    const term = draft.trim();
    if (!term || invalid) return;
    if (!value.includes(term)) onChange([...value, term]);
    setDraft("");
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <label className="relative">
        <span className="sr-only">{t("Filter by parameter")}</span>
        <SlidersHorizontal className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={add}
          placeholder={t("Parameter, e.g. env=uat or name~text")}
          aria-invalid={invalid}
          title={t("Enter to add. name=value matches exactly, name~text by substring, name alone when present.")}
          className="h-8 w-64 pl-8 font-mono text-xs"
        />
      </label>
      {value.map((term) => (
        <span key={term} className="inline-flex max-w-64 items-center gap-1 rounded-md bg-primary/10 py-0.5 pr-1 pl-2 font-mono text-[11px] text-primary">
          <span className="truncate" title={term}>
            {term}
          </span>
          <button type="button" className="rounded p-0.5 hover:bg-primary/15" aria-label={t("Remove filter {{term}}", { term })} onClick={() => onChange(value.filter((v) => v !== term))}>
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
    </div>
  );
}
