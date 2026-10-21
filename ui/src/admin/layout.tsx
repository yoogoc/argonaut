import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { listOrphanGrants } from "@/api/authz";
import { Page, PageHeader } from "@/components/common/page";

import { AdminTabs } from "./admin-tabs";
import { StatusBanner } from "./status-banner";

export function AdminLayout({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation();
  const orphans = useQuery({ queryKey: ["authz", "orphans"], queryFn: listOrphanGrants });
  return (
    <Page>
      <PageHeader title={t("Permissions")} description={t("Grant users a role on the whole platform, a namespace, a template or a cluster template. Runs and cron workflows inherit the grants of the template they come from.")} actions={actions} />
      <StatusBanner />
      <AdminTabs orphanCount={orphans.data?.length} />
      {children}
    </Page>
  );
}
