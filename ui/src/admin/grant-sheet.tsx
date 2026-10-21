import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { createGrant, listRoles } from "@/api/authz";
import { templateQueries } from "@/api/templates";
import type { Grant, Role } from "@/api/types";
import { ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useNamespace } from "@/hooks/use-namespace";
import { getRevision } from "@/lib/revision";
import { cn } from "@/lib/utils";

type Scope = Grant["resourceType"];

/** New grant (mockup "新增授权"): subject, scope, role — written as one atomic revision. */
export function GrantSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { namespace: currentNs, namespaces } = useNamespace();
  const [subject, setSubject] = useState("");
  const [scope, setScope] = useState<Scope>("template");
  const [namespace, setNamespace] = useState(currentNs);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("operator");
  const roles = useQuery({ queryKey: ["authz", "roles"], queryFn: listRoles, staleTime: Infinity });
  const templates = useQuery({ ...templateQueries.list({ cluster: false, namespace }), enabled: scope === "template" });
  const clusterTemplates = useQuery({ ...templateQueries.list({ cluster: true }), enabled: scope === "cluster_template" });

  const create = useMutation({
    mutationFn: () => createGrant({ subject: subject.trim(), role, resourceType: scope, namespace: scope === "namespace" || scope === "template" ? namespace : undefined, name: scope === "template" || scope === "cluster_template" ? name : undefined }),
    onSuccess: () => {
      toast.success(t("Granted. Effective on every replica from revision r{{rev}}.", { rev: getRevision() }));
      void queryClient.invalidateQueries({ queryKey: ["authz"] });
      onOpenChange(false);
      setSubject("");
      setName("");
    },
  });

  const options = (scope === "cluster_template" ? clusterTemplates.data?.items : templates.data?.items) ?? [];
  const scopes: { value: Scope; label: string; hint?: string }[] = [
    { value: "global", label: t("Global") },
    { value: "namespace", label: t("Namespace") },
    { value: "template", label: t("Template") },
    { value: "cluster_template", label: t("Cluster template"), hint: t("Definition only") },
  ];
  const ready = subject.trim() && ((scope !== "template" && scope !== "cluster_template") || name);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>{t("New grant")}</SheetTitle>
          <SheetDescription>{t("Grants are per user (the OIDC subject). Runs inherit their template's grants.")}</SheetDescription>
        </SheetHeader>
        <form
          id="grant-form"
          className="flex-1 space-y-6 overflow-auto p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) create.mutate();
          }}
        >
          {create.error ? <ErrorState error={create.error} /> : null}
          <div className="space-y-2">
            <Label htmlFor="g-subject">{t("User")}</Label>
            <Input id="g-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t("OIDC subject (sub)")} className="font-mono" autoComplete="off" />
          </div>
          <fieldset className="space-y-3">
            <legend className="mb-3 text-sm font-medium">{t("Scope")}</legend>
            <RadioGroup value={scope} onValueChange={(v) => setScope(v as Scope)} className="grid grid-cols-2 gap-2">
              {scopes.map((s) => (
                <Label key={s.value} htmlFor={`scope-${s.value}`} className={cn("flex cursor-pointer flex-col items-start gap-1 rounded-lg border p-3", scope === s.value && "border-primary bg-primary/5")}>
                  <span className="flex items-center gap-2">
                    <RadioGroupItem value={s.value} id={`scope-${s.value}`} />
                    {s.label}
                  </span>
                  {s.hint && <span className="pl-6 text-xs font-normal text-muted-foreground">{s.hint}</span>}
                </Label>
              ))}
            </RadioGroup>
            {(scope === "namespace" || scope === "template") && (
              <div className="space-y-1.5">
                <Label>{t("Namespace")}</Label>
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
              </div>
            )}
            {(scope === "template" || scope === "cluster_template") && (
              <div className="space-y-1.5">
                <Label>{scope === "template" ? t("Template") : t("Cluster template")}</Label>
                <Select value={name} onValueChange={setName}>
                  <SelectTrigger className="w-full font-mono">
                    <SelectValue placeholder={t("Choose…")} />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((o) => (
                      <SelectItem key={o.metadata.name} value={o.metadata.name} className="font-mono">
                        {o.metadata.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="mb-3 text-sm font-medium">{t("Role")}</legend>
            <RadioGroup value={role} onValueChange={(v) => setRole(v as Role)} className="space-y-2">
              {(roles.data ?? []).map((r) => (
                <Label key={r.name} htmlFor={`role-${r.name}`} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3", role === r.name && "border-primary bg-primary/5")}>
                  <RadioGroupItem value={r.name} id={`role-${r.name}`} className="mt-0.5" />
                  <span className="flex flex-col gap-0.5">
                    <span>{r.name}</span>
                    <span className="text-xs leading-relaxed font-normal text-muted-foreground">{t(r.description)}</span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </fieldset>
        </form>
        <SheetFooter className="border-t bg-muted/40">
          <p className="text-[13px] text-muted-foreground">{t("Takes effect on every replica as soon as it is saved.")}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("Cancel")}
            </Button>
            <Button type="submit" form="grant-form" disabled={!ready || create.isPending}>
              {t("Grant")}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
