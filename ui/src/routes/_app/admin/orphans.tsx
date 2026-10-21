import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { deleteGrant, listOrphanGrants } from "@/api/authz";
import { GrantsTable } from "@/admin/grants-table";
import { AdminLayout } from "@/admin/layout";
import { EmptyState, ErrorState, errorMessage, Spinner } from "@/components/common/states";

export const Route = createFileRoute("/_app/admin/orphans")({ component: OrphansPage });

function OrphansPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["authz", "orphans"], queryFn: listOrphanGrants });
  const revoke = useMutation({
    mutationFn: (id: string) => deleteGrant(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["authz"] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <AdminLayout>
      <p className="max-w-3xl text-sm text-muted-foreground">
        {t("Grants on templates that no longer exist. They are kept rather than deleted automatically, because a GitOps tool may delete and recreate a template — and a template recreated under the same name picks its grants up again. Revoke the ones that should not come back.")}
      </p>
      {query.error ? <ErrorState error={query.error} /> : query.isPending ? <Spinner /> : query.data?.length ? <GrantsTable grants={query.data} onRevoke={(g) => revoke.mutate(g.id)} highlightOrphans /> : <EmptyState title={t("No orphan grants")} />}
    </AdminLayout>
  );
}
