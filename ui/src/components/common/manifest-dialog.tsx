import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { ErrorState } from "./states";
import { YamlEditor } from "./yaml-editor";

/** Create or edit a resource as YAML, with lint before save. */
export function ManifestDialog({
  open,
  onOpenChange,
  title,
  description,
  initial,
  path,
  onLint,
  onSave,
  saveLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  initial: string;
  path: string;
  onLint?: (manifest: string) => Promise<unknown>;
  onSave: (manifest: string) => Promise<unknown>;
  saveLabel: string;
}) {
  const { t } = useTranslation();
  const [manifest, setManifest] = useState(initial);
  useEffect(() => {
    if (open) setManifest(initial);
  }, [open, initial]);
  const lint = useMutation({ mutationFn: () => onLint!(manifest) });
  const save = useMutation({ mutationFn: () => onSave(manifest), onSuccess: () => onOpenChange(false) });
  const error = save.error ?? lint.error;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(85vh,760px)] max-w-3xl flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {error ? <ErrorState error={error} /> : lint.isSuccess ? <p className="text-sm text-phase-ok">{t("Lint passed")}</p> : null}
        <YamlEditor value={manifest} onChange={setManifest} path={path} className="min-h-0 flex-1" />
        <DialogFooter>
          {onLint && (
            <Button variant="outline" onClick={() => lint.mutate()} disabled={lint.isPending}>
              {t("Lint")}
            </Button>
          )}
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? t("Saving…") : saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
