import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { listRoles } from "@/api/authz";
import { roleTone } from "@/admin/grants-table";
import { AdminLayout } from "@/admin/layout";
import { Spinner } from "@/components/common/states";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/admin/roles")({ component: RolesPage });

function RolesPage() {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: ["authz", "roles"], queryFn: listRoles, staleTime: Infinity });
  if (!query.data) return <AdminLayout><Spinner /></AdminLayout>;
  let previous = new Set<string>();
  return (
    <AdminLayout>
      <div className="grid gap-4 md:grid-cols-2">
        {query.data.map((r) => {
          const added = r.actions.filter((a) => !previous.has(a));
          previous = new Set(r.actions);
          return (
            <section key={r.name} className="space-y-3 rounded-xl border bg-card p-4">
              <h2 className="flex items-center gap-2">
                <span className={cn("rounded-md px-2 py-0.5 text-sm font-semibold", roleTone[r.name])}>{r.name}</span>
              </h2>
              <p className="text-sm text-muted-foreground">{t(r.description)}</p>
              <div className="flex flex-wrap gap-1.5">
                {added.map((a) => (
                  <span key={a} className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs">
                    {a}
                  </span>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      <p className="text-sm text-muted-foreground">{t("Grants on a cluster template cover its definition only; runs created from it are governed by the namespace they run in.")}</p>
    </AdminLayout>
  );
}
