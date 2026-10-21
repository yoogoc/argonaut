import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { createWorkflow, lintWorkflow } from "@/api/workflows";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { ErrorState } from "./states";
import { YamlEditor } from "./yaml-editor";

const EXAMPLE = `apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: hello-
spec:
  entrypoint: main
  templates:
    - name: main
      container:
        image: busybox
        command: [echo, hello]
`;

/**
 * Submits a raw Workflow manifest. This needs workflow:submit on the whole namespace, and the server
 * strips any template-lineage labels from it, so a manifest cannot borrow another template's grants.
 */
export function SubmitYamlDialog({ open, onOpenChange, namespace }: { open: boolean; onOpenChange: (open: boolean) => void; namespace: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [manifest, setManifest] = useState(EXAMPLE);
  const lint = useMutation({ mutationFn: () => lintWorkflow(namespace, manifest) });
  const submit = useMutation({
    mutationFn: () => createWorkflow(namespace, manifest),
    onSuccess: (wf) => {
      onOpenChange(false);
      void navigate({ to: "/workflows/$namespace/$name", params: { namespace: wf.metadata.namespace, name: wf.metadata.name } });
    },
  });
  const error = submit.error ?? lint.error;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(80vh,720px)] max-w-3xl flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("Submit a workflow from YAML")}</DialogTitle>
          <DialogDescription>
            {t("Runs in namespace")} <span className="font-mono">{namespace}</span>. {t("Requires permission to submit in the whole namespace.")}
          </DialogDescription>
        </DialogHeader>
        {error ? <ErrorState error={error} /> : lint.isSuccess ? <p className="text-sm text-phase-ok">{t("Lint passed")}</p> : null}
        <YamlEditor value={manifest} onChange={setManifest} path="submit-workflow.yaml" className="min-h-0 flex-1" />
        <DialogFooter>
          <Button variant="outline" onClick={() => lint.mutate()} disabled={lint.isPending}>
            {t("Lint")}
          </Button>
          <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
            {submit.isPending ? t("Submitting…") : t("Submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
