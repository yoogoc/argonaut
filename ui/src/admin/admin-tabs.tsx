import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

const tab = "flex h-10 items-center gap-1.5 border-b-2 border-transparent px-1 text-sm text-muted-foreground hover:text-foreground";

/** Tabs across the permission pages; each is its own route so it can be linked to. */
export function AdminTabs({ orphanCount }: { orphanCount?: number }) {
  const { t } = useTranslation();
  const items: { to: string; label: string; count?: number }[] = [
    { to: "/admin/authz", label: t("Grants") },
    { to: "/admin/orphans", label: t("Orphan grants"), count: orphanCount },
    { to: "/admin/mine", label: t("My permissions") },
    { to: "/admin/roles", label: t("Roles") },
    { to: "/admin/policies", label: t("Policies") },
    { to: "/admin/audit", label: t("Audit log") },
  ];
  return (
    <nav aria-label={t("Permission views")} className="flex flex-wrap gap-6 border-b">
      {items.map((i) => (
        <Link key={i.to} to={i.to} className={tab} activeProps={{ className: cn(tab, "border-primary font-semibold text-foreground"), "aria-current": "page" }}>
          {i.label}
          {i.count ? <span className="rounded-full bg-phase-susp-bg px-1.5 text-[11px] font-semibold text-phase-susp">{i.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}
