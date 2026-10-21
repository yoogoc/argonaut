import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CheckCircle2, Play, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { TemplateRef } from "@/api/templates";
import type { WorkflowTemplate } from "@/api/types";
import { submitWorkflow } from "@/api/workflows";
import { ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useNamespace } from "@/hooks/use-namespace";

/**
 * The submit panel (DESIGN §5.4 / mockup "模板详情与提交"): entrypoint, a form generated from
 * spec.arguments.parameters (enum → select), labels. Lineage labels are set by the server.
 */
export function SubmitPanel({ open, onOpenChange, template, templateRef }: { open: boolean; onOpenChange: (open: boolean) => void; template: WorkflowTemplate; templateRef: TemplateRef }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { namespace: current, namespaces } = useNamespace();
  const params = template.spec.arguments?.parameters ?? [];
  const [namespace, setNamespace] = useState(templateRef.cluster ? current : templateRef.namespace);
  const [entrypoint, setEntrypoint] = useState(template.spec.entrypoint ?? "");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(params.map((p) => [p.name, p.value ?? p.default ?? ""])));
  const [labels, setLabels] = useState<string[]>([]);
  const [labelDraft, setLabelDraft] = useState("");

  const missing = params.filter((p) => p.value === undefined && p.default === undefined && !values[p.name]).map((p) => p.name);
  const submit = useMutation({
    mutationFn: () =>
      submitWorkflow(namespace, {
        resourceKind: templateRef.cluster ? "ClusterWorkflowTemplate" : "WorkflowTemplate",
        resourceName: template.metadata.name,
        entryPoint: entrypoint || undefined,
        parameters: Object.entries(values).map(([k, v]) => `${k}=${v}`),
        labels: labels.length ? labels : undefined,
      }),
    onSuccess: (wf) => {
      onOpenChange(false);
      void navigate({ to: "/workflows/$namespace/$name", params: { namespace: wf.metadata.namespace, name: wf.metadata.name } });
    },
  });

  const entrypoints = (template.spec.templates ?? []).map((tpl) => tpl.name).filter(Boolean) as string[];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>{t("Submit workflow")}</SheetTitle>
          <SheetDescription>
            {t("From template")} <span className="font-mono">{templateRef.cluster ? template.metadata.name : `${templateRef.namespace}/${template.metadata.name}`}</span>
          </SheetDescription>
        </SheetHeader>
        <form
          id="submit-form"
          className="flex-1 space-y-5 overflow-auto p-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit.mutate();
          }}
        >
          {submit.error ? <ErrorState error={submit.error} /> : null}
          {templateRef.cluster && (
            <div className="space-y-2">
              <Label>{t("Run in namespace")}</Label>
              <Select value={namespace} onValueChange={setNamespace}>
                <SelectTrigger className="w-full font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {namespaces.map((ns) => (
                    <SelectItem key={ns} value={ns} className="font-mono">
                      {ns}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("The run belongs to this namespace and needs permission to submit there.")}</p>
            </div>
          )}
          <div className="space-y-2">
            <Label>{t("Entrypoint")}</Label>
            <Select value={entrypoint} onValueChange={setEntrypoint}>
              <SelectTrigger className="w-full font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {entrypoints.map((name) => (
                  <SelectItem key={name} value={name} className="font-mono">
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-semibold">{t("Parameters")}</legend>
            {params.length === 0 && <p className="text-sm text-muted-foreground">{t("This template takes no parameters.")}</p>}
            {params.map((p) => {
              const required = p.value === undefined && p.default === undefined;
              return (
                <div key={p.name} className="space-y-1.5">
                  <Label htmlFor={`p-${p.name}`} className="font-mono">
                    {p.name}
                    {required && <span className="text-destructive">*</span>}
                  </Label>
                  {p.enum?.length ? (
                    <Select value={values[p.name] ?? ""} onValueChange={(v) => setValues((c) => ({ ...c, [p.name]: v }))}>
                      <SelectTrigger id={`p-${p.name}`} className="w-full font-mono">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {p.enum.map((v) => (
                          <SelectItem key={v} value={v} className="font-mono">
                            {v}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input id={`p-${p.name}`} value={values[p.name] ?? ""} onChange={(e) => setValues((c) => ({ ...c, [p.name]: e.target.value }))} className="font-mono" required={required} />
                  )}
                  {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
                </div>
              );
            })}
          </fieldset>
          <div className="space-y-2">
            <Label htmlFor="label-draft">{t("Labels")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {labels.map((l) => (
                <span key={l} className="inline-flex h-7 items-center gap-1 rounded-md bg-muted pr-1 pl-2 font-mono text-xs">
                  {l}
                  <button type="button" aria-label={t("Remove label {{label}}", { label: l })} onClick={() => setLabels((c) => c.filter((x) => x !== l))} className="rounded p-0.5 hover:bg-background">
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
            <Input
              id="label-draft"
              value={labelDraft}
              placeholder="key=value"
              className="font-mono text-xs"
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && labelDraft.includes("=")) {
                  e.preventDefault();
                  setLabels((c) => [...c, labelDraft.trim()]);
                  setLabelDraft("");
                }
              }}
            />
            <p className="text-xs text-muted-foreground">{t("Press Enter to add. The template-lineage labels are written by the server and cannot be set here.")}</p>
          </div>
        </form>
        <SheetFooter className="border-t bg-muted/40">
          {missing.length === 0 ? (
            <p className="flex items-center gap-1.5 text-sm text-phase-ok">
              <CheckCircle2 className="size-4" aria-hidden />
              {t("All required parameters are filled")}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t("Missing: {{names}}", { names: missing.join(", ") })}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("Cancel")}
            </Button>
            <Button type="submit" form="submit-form" disabled={submit.isPending || missing.length > 0}>
              <Play aria-hidden />
              {submit.isPending ? t("Submitting…") : t("Submit and view")}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
