import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Workflow } from "@/api/types";
import { ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface RunOptions {
  /** "name=value" pairs, empty when not overriding. */
  parameters: string[];
  memoized: boolean;
}

/**
 * Options shared by Resubmit and Retry node: run with different inputs, and reuse what succeeded.
 * With `exclusive`, ticking one clears the other — on resubmit the two together would let Argo
 * derive the memoization key from the old inputs while the step runs with the new ones.
 */
export function RunOptionsDialog({
  open,
  onOpenChange,
  title,
  description,
  workflow,
  confirmLabel,
  memoizedLabel,
  memoizedHint,
  memoizedDisabledReason,
  memoizedDefault = false,
  exclusive = false,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  workflow: Workflow;
  confirmLabel: string;
  memoizedLabel: string;
  memoizedHint: string;
  memoizedDisabledReason?: string;
  memoizedDefault?: boolean;
  exclusive?: boolean;
  pending?: boolean;
  error?: unknown;
  onConfirm: (options: RunOptions) => void;
}) {
  const { t } = useTranslation();
  const declared = workflow.spec.arguments?.parameters ?? [];
  const [override, setOverride] = useState(false);
  const [memoized, setMemoized] = useState(memoizedDefault && !memoizedDisabledReason);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(declared.map((p) => [p.name, p.value ?? p.default ?? ""])));
  const memoDisabled = !!memoizedDisabledReason || (exclusive && override);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {error !== undefined && error !== null && <ErrorState error={error} />}
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <Checkbox
              id="ro-override"
              checked={override}
              onCheckedChange={(v) => {
                setOverride(!!v);
                if (v && exclusive) setMemoized(false);
              }}
            />
            <div className="space-y-1">
              <Label htmlFor="ro-override">{t("Override parameters")}</Label>
              <p className="text-xs text-muted-foreground">{t("Run with different workflow arguments.")}</p>
            </div>
          </div>
          {override &&
            (declared.length === 0 ? (
              <p className="ml-7 text-sm text-muted-foreground">{t("This workflow declares no arguments.")}</p>
            ) : (
              <div className="ml-7 grid grid-cols-[minmax(6rem,max-content)_minmax(0,1fr)] items-center gap-2">
                {declared.map((p) => (
                  <div key={p.name} className="contents">
                    <Label htmlFor={`ro-${p.name}`} className="font-mono text-xs">
                      {p.name}
                    </Label>
                    <Input id={`ro-${p.name}`} value={values[p.name] ?? ""} onChange={(e) => setValues((c) => ({ ...c, [p.name]: e.target.value }))} className="font-mono text-xs" />
                  </div>
                ))}
              </div>
            ))}
          <div className="flex items-start gap-3">
            <Checkbox
              id="ro-memo"
              checked={memoized}
              disabled={memoDisabled}
              onCheckedChange={(v) => {
                setMemoized(!!v);
                if (v && exclusive) setOverride(false);
              }}
            />
            <div className="space-y-1">
              <Label htmlFor="ro-memo" className={memoDisabled ? "opacity-60" : ""}>
                {memoizedLabel}
              </Label>
              <p className="text-xs text-muted-foreground">
                {memoizedDisabledReason ?? (exclusive && override ? t("Cannot be combined with overridden parameters: the reused cache key would still describe the old inputs.") : memoizedHint)}
              </p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={pending}
            onClick={() => onConfirm({ parameters: override ? Object.entries(values).map(([k, v]) => `${k}=${v}`) : [], memoized })}
          >
            {pending ? t("Working…") : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
