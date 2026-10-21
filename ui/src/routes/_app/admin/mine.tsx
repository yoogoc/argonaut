import { createFileRoute } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useMyPermissions } from "@/api/authz";
import { GrantsTable } from "@/admin/grants-table";
import { AdminLayout } from "@/admin/layout";
import { EmptyState, ErrorState, Spinner } from "@/components/common/states";

export const Route = createFileRoute("/_app/admin/mine")({ component: MinePage });

function MinePage() {
  const { t } = useTranslation();
  const query = useMyPermissions();
  return (
    <AdminLayout>
      {query.error ? (
        <ErrorState error={query.error} />
      ) : query.isPending ? (
        <Spinner />
      ) : (
        <>
          <p className="flex items-center gap-2 text-sm">
            <ShieldCheck className="size-4 text-phase-ok" aria-hidden />
            {t("Signed in as")} <span className="font-mono">{query.data.subject}</span>
            {query.data.superAdmin && <span className="rounded-full bg-foreground px-2 py-0.5 text-xs font-bold text-background">{t("Super admin (from configuration)")}</span>}
            <span className="text-muted-foreground">· r{query.data.revision ?? 0}</span>
          </p>
          {query.data.grants?.length ? <GrantsTable grants={query.data.grants} /> : <EmptyState title={query.data.superAdmin ? t("Super admins need no grants") : t("You have no grants")} />}
        </>
      )}
    </AdminLayout>
  );
}
