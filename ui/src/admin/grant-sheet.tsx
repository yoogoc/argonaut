import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { createGrant, listRoles, searchUsers } from "@/api/authz";
import { templateQueries } from "@/api/templates";
import type { DirectoryUser, Grant, Role } from "@/api/types";
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
type Recipient = { subjectType: "user" | "email"; subject: string };

function recipientFor(user: DirectoryUser): Recipient | undefined {
  if (user.subject) return { subjectType: "user", subject: user.subject };
  if (user.email) return { subjectType: "email", subject: user.email };
}

/** New grant (mockup "新增授权"): subject, scope, role — written as one atomic revision. */
export function GrantSheet({ open, onOpenChange, user }: { open: boolean; onOpenChange: (open: boolean) => void; user?: DirectoryUser }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { namespace: currentNs, namespaces } = useNamespace();
  const [subject, setSubject] = useState("");
  const [selected, setSelected] = useState<Recipient>();
  const [manual, setManual] = useState(false);
  const [scope, setScope] = useState<Scope>("template");
  const [namespace, setNamespace] = useState(currentNs);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("operator");
  const roles = useQuery({ queryKey: ["authz", "roles"], queryFn: listRoles, staleTime: Infinity });
  const templates = useQuery({ ...templateQueries.list({ cluster: false, namespace }), enabled: scope === "template" });
  const clusterTemplates = useQuery({ ...templateQueries.list({ cluster: true }), enabled: scope === "cluster_template" });
  const needsTemplate = scope === "template" || scope === "cluster_template";
  const scopeReady = !needsTemplate || !!name;
  const resource = {
    namespace: scope === "namespace" || scope === "template" ? namespace : undefined,
    template: scope === "template" ? name : undefined,
    clusterTemplate: scope === "cluster_template" ? name : undefined,
  };
  const text = subject.trim();
  const users = useQuery({
    queryKey: ["authz", "users", resource, text],
    queryFn: ({ signal }) => searchUsers(text, resource, signal),
    enabled: open && !user && scopeReady && !manual && !selected && text.length >= 2,
  });
  const recipient: Recipient | undefined = user ? recipientFor(user) : manual && text ? { subjectType: "user", subject: text } : selected;
  const preauthorize = users.isSuccess && /^[^\s@]+@[^\s@]+$/.test(text) &&
    !users.data.some((user) => (!user.subject || user.emailVerified) && user.email?.toLowerCase() === text.toLowerCase());

  const create = useMutation({
    mutationFn: (to: Recipient) => createGrant({ ...to, role, resourceType: scope, namespace: resource.namespace, name: needsTemplate ? name : undefined }),
    onSuccess: (grant) => {
      toast.success(grant.subjectType === "email" ? t("Email pre-authorized.") : t("Granted. Effective on every replica from revision r{{rev}}.", { rev: getRevision() }));
      void queryClient.invalidateQueries({ queryKey: ["authz"] });
      onOpenChange(false);
      setSubject("");
      setSelected(undefined);
      setManual(false);
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
  const ready = scopeReady && !!recipient;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>{t("New grant")}</SheetTitle>
          <SheetDescription>{t("Select a user or pre-authorize an email address. Runs inherit their template's grants.")}</SheetDescription>
        </SheetHeader>
        <form
          id="grant-form"
          className="flex-1 space-y-6 overflow-auto p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (scopeReady && recipient) create.mutate(recipient);
          }}
        >
          {create.error ? <ErrorState error={create.error} /> : null}
          <fieldset className="space-y-3">
            <legend className="mb-3 text-sm font-medium">{t("Scope")}</legend>
            <RadioGroup value={scope} onValueChange={(v) => {
              setScope(v as Scope);
              setName("");
            }} className="grid grid-cols-2 gap-2">
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
                <Select value={namespace} onValueChange={(v) => {
                  setNamespace(v);
                  setName("");
                }}>
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
          {user ? (
            <div className="space-y-1">
              <p className="text-sm font-medium">{t("User")}</p>
              <div className="space-y-1 rounded-md border px-3 py-2 text-sm">
                <p className="break-words font-medium">{user.name || user.email || user.subject}</p>
                {user.email && <p className="break-all text-muted-foreground">{user.email}</p>}
                <p className="break-all font-mono text-xs text-muted-foreground">{user.subject || t("Pending sign-in")}</p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="g-subject">{t("User")}</Label>
                <Button type="button" variant="ghost" size="sm" onClick={() => {
                  setManual(!manual);
                  setSubject("");
                  setSelected(undefined);
                }}>
                  {t(manual ? "Search directory" : "Use OIDC subject")}
                </Button>
              </div>
              <Input
                id="g-subject"
                value={subject}
                onChange={(e) => {
                  setSubject(e.target.value);
                  setSelected(undefined);
                }}
                placeholder={t(manual ? "OIDC subject (sub)" : "Search by name or email")}
                autoComplete="off"
              />
              {!manual && !selected && !scopeReady && <p className="text-xs text-muted-foreground">{t("Choose a grant scope to search users.")}</p>}
              {!manual && !selected && scopeReady && text.length >= 2 && (
                <div className="space-y-1">
                  {users.isFetching && <p className="text-xs text-muted-foreground" role="status">{t("Loading…")}</p>}
                  {users.error && <ErrorState error={users.error} />}
                  {users.data?.map((user) => (
                    <Button
                      key={user.subject ? `user:${user.subject}` : `email:${user.email}`}
                      type="button"
                      variant="outline"
                      className="h-auto w-full min-w-0 flex-col items-start gap-0.5 whitespace-normal text-left"
                      onClick={() => {
                        setSelected(recipientFor(user));
                        setSubject(user.name || user.email || user.subject || "");
                      }}
                    >
                      <span className="break-all">{user.name || user.subject}</span>
                      {user.email && (
                        <span className="break-all text-xs text-muted-foreground">
                          {user.email}{!user.subject ? ` · ${t("Pending sign-in")}` : !user.emailVerified && ` · ${t("Unverified email")}`}
                        </span>
                      )}
                      {user.subject && <span className="break-all font-mono text-xs text-muted-foreground">{user.subject}</span>}
                    </Button>
                  ))}
                  {preauthorize && (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto w-full justify-start whitespace-normal break-all text-left"
                      onClick={() => setSelected({ subjectType: "email", subject: text })}
                    >
                      {t("Pre-authorize {{email}}", { email: text })}
                    </Button>
                  )}
                  {users.isSuccess && !users.data.length && !preauthorize && <p className="text-xs text-muted-foreground">{t("No matching users")}</p>}
                </div>
              )}
              {selected && <p className="break-all text-xs text-muted-foreground">{t(selected.subjectType === "email" ? "Email selected: {{subject}}" : "User selected: {{subject}}", { subject: selected.subject })}</p>}
            </div>
          )}
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
          <p className="text-[13px] text-muted-foreground">{t(recipient?.subjectType === "email" ? "Access begins when the user signs in with this verified email." : "Takes effect on every replica as soon as it is saved.")}</p>
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
