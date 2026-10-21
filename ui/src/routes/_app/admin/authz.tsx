import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { deleteGrant, listGrants } from "@/api/authz";
import type { Grant } from "@/api/types";
import { GrantSheet } from "@/admin/grant-sheet";
import { GrantsTable, scopeLabel } from "@/admin/grants-table";
import { AdminLayout } from "@/admin/layout";
import { ConfirmAction } from "@/components/common/confirm-action";
import { EmptyState, ErrorState, errorMessage, Spinner } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/_app/admin/authz")({ component: GrantsPage });

function GrantsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [revoking, setRevoking] = useState<Grant>();
  const query = useQuery({ queryKey: ["authz", "grants"], queryFn: () => listGrants() });
  const revoke = useMutation({
    mutationFn: (g: Grant) => deleteGrant(g.id),
    onSuccess: () => {
      toast.success(t("Revoked on every replica."));
      void queryClient.invalidateQueries({ queryKey: ["authz"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const grants = (query.data ?? []).filter((g) => !q || [g.subject, g.namespace, g.name, g.role].join(" ").toLowerCase().includes(q.toLowerCase()));
  return (
    <AdminLayout
      actions={
        <Button onClick={() => setOpen(true)}>
          <Plus aria-hidden />
          {t("New grant")}
        </Button>
      }
    >
      <label className="relative max-w-sm">
        <span className="sr-only">{t("Search grants")}</span>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search subject or scope")} className="bg-card pl-9" />
      </label>
      {query.error ? <ErrorState error={query.error} /> : query.isPending ? <Spinner /> : grants.length ? <GrantsTable grants={grants} onRevoke={setRevoking} /> : <EmptyState title={t("No grants")} />}
      <GrantSheet open={open} onOpenChange={setOpen} />
      <ConfirmAction
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(undefined)}
        title={t("Revoke this grant?")}
        description={revoking ? `${revoking.subject} · ${revoking.role} · ${scopeLabel(revoking, t).join(" ")}` : undefined}
        confirmLabel={t("Revoke")}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      />
    </AdminLayout>
  );
}
