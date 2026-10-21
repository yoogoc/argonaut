import { useTranslation } from "react-i18next";

import type { Grant } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";

export const roleTone: Record<string, string> = {
  viewer: "bg-muted text-foreground",
  operator: "bg-phase-run-bg text-phase-run",
  editor: "bg-node-script-bg text-node-script",
  admin: "bg-foreground text-background",
};

export function scopeLabel(g: Grant, t: (s: string) => string) {
  switch (g.resourceType) {
    case "global":
      return [t("Global"), "*"];
    case "namespace":
      return [t("Namespace"), g.namespace];
    case "cluster_template":
      return [t("Cluster template"), g.name];
    default:
      return [t("Template"), `${g.namespace}/${g.name}`];
  }
}

export function GrantsTable({ grants, onRevoke, highlightOrphans }: { grants: Grant[]; onRevoke?: (g: Grant) => void; highlightOrphans?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="overflow-x-auto">
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead>{t("Subject")}</TableHead>
              <TableHead>{t("Scope")}</TableHead>
              <TableHead>{t("Role")}</TableHead>
              <TableHead>{t("Granted by")}</TableHead>
              <TableHead>{t("When")}</TableHead>
              <TableHead>{t("Revision")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("Actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.map((g) => {
              const [kind, name] = scopeLabel(g, t);
              return (
                <TableRow key={g.id} className={cn(highlightOrphans && "bg-phase-susp-bg/40")}>
                  <TableCell className="font-mono text-[13px]">{g.subject}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{kind}</span>
                      <span className="font-mono text-[13px]">{name}</span>
                      {highlightOrphans && <span className="rounded-full bg-phase-susp-bg px-1.5 text-[11px] font-semibold text-phase-susp">{t("Template missing")}</span>}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className={cn("rounded-md px-2 py-0.5 text-xs font-semibold", roleTone[g.role])}>{g.role}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{g.createdBy || "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{formatTimestamp(g.createdAt)}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{g.revision ? `r${g.revision}` : "—"}</TableCell>
                  <TableCell className="text-right">
                    {onRevoke && (
                      <Button variant="outline" size="sm" className="h-7 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => onRevoke(g)}>
                        {t("Revoke")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
