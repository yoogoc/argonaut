import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { createPolicy, deletePolicy, listPolicies, type Policy, setPolicyEnabled } from "@/api/authz";
import { AdminLayout } from "@/admin/layout";
import { ConfirmAction } from "@/components/common/confirm-action";
import { EmptyState, ErrorState, errorMessage, Spinner } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatTimestamp } from "@/lib/format";

export const Route = createFileRoute("/_app/admin/policies")({ component: PoliciesPage });

const EXAMPLE = `// Nobody may terminate runs labelled env=prod, whatever their role.
forbid (
  principal,
  action == Action::"workflow:terminate",
  resource
)
when { resource.labels has env && resource.labels.env == "prod" };`;

/**
 * Custom Cedar policies on top of the built-in roles (DESIGN §4.2). They share the authorization
 * revision with grants, so a change takes effect on every replica at once.
 */
function PoliciesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["authz", "policies"], queryFn: listPolicies });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ name: "", description: "", body: EXAMPLE });
  const [deleting, setDeleting] = useState<Policy>();
  const done = () => void queryClient.invalidateQueries({ queryKey: ["authz"] });
  const create = useMutation({
    mutationFn: () => createPolicy(draft),
    onSuccess: () => {
      setOpen(false);
      setDraft({ name: "", description: "", body: EXAMPLE });
      done();
    },
  });
  const toggle = useMutation({ mutationFn: ({ p, on }: { p: Policy; on: boolean }) => setPolicyEnabled(p, on), onSuccess: done, onError: (e) => toast.error(errorMessage(e)) });
  const remove = useMutation({ mutationFn: (p: Policy) => deletePolicy(p), onSuccess: done, onError: (e) => toast.error(errorMessage(e)) });

  return (
    <AdminLayout
      actions={
        <Button onClick={() => setOpen(true)}>
          <Plus aria-hidden />
          {t("New policy")}
        </Button>
      }
    >
      <p className="max-w-3xl text-sm text-muted-foreground">
        {t("Cedar policies evaluated together with the built-in role policies. A forbid always wins over a permit. Resources expose kind, namespace, name and labels; the context exposes clusterTemplatesReadable.")}
      </p>
      {query.error ? (
        <ErrorState error={query.error} />
      ) : query.isPending ? (
        <Spinner />
      ) : !query.data.length ? (
        <EmptyState title={t("No custom policies")} description={t("Only the built-in role policies apply.")} />
      ) : (
        <div className="space-y-3">
          {query.data.map((p) => (
            <section key={p.id} className="space-y-3 rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-mono text-sm font-semibold">{p.name}</h2>
                {p.error && <span className="rounded-full bg-phase-fail-bg px-2 py-0.5 text-xs font-semibold text-phase-fail">{t("Does not compile; skipped")}</span>}
                <span className="text-xs text-muted-foreground">
                  {p.createdBy} · {formatTimestamp(p.createdAt)} · r{p.revision ?? 0}
                </span>
                <div className="ml-auto flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Switch id={`en-${p.id}`} checked={!!p.enabled} onCheckedChange={(on) => toggle.mutate({ p, on })} />
                    <Label htmlFor={`en-${p.id}`} className="text-[13px] font-normal">
                      {p.enabled ? t("Enabled") : t("Disabled")}
                    </Label>
                  </div>
                  <Button variant="ghost" size="icon" className="size-8 text-destructive" aria-label={t("Delete policy {{name}}", { name: p.name })} onClick={() => setDeleting(p)}>
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </div>
              {p.description && <p className="text-sm text-muted-foreground">{p.description}</p>}
              {p.error && <p className="font-mono text-xs text-phase-fail">{p.error}</p>}
              <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-200">{p.body}</pre>
            </section>
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("New policy")}</DialogTitle>
            <DialogDescription>{t("The policy is checked for syntax before it is saved.")}</DialogDescription>
          </DialogHeader>
          {create.error ? <ErrorState error={create.error} /> : null}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="pol-name">{t("Name")}</Label>
              <Input id="pol-name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} className="font-mono" placeholder="prod-no-terminate" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pol-desc">{t("Description")}</Label>
              <Input id="pol-desc" value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pol-body">{t("Cedar policy")}</Label>
              <Textarea id="pol-body" value={draft.body} onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))} rows={10} className="font-mono text-xs" spellCheck={false} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button onClick={() => create.mutate()} disabled={!draft.name || create.isPending}>
              {t("Create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmAction open={!!deleting} onOpenChange={(o) => !o && setDeleting(undefined)} title={t("Delete policy {{name}}?", { name: deleting?.name })} confirmLabel={t("Delete")} onConfirm={() => deleting && remove.mutate(deleting)} />
    </AdminLayout>
  );
}
