import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Layers, Plus, Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useActions } from "@/api/authz";
import { COMPONENT_LABEL, MODIFIED_BY_ANNOTATION, templateQueries, type TemplateScope } from "@/api/templates";
import { Page, PageHeader } from "@/components/common/page";
import { EmptyState, ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRelative } from "@/lib/format";

/** The WorkflowTemplate and ClusterWorkflowTemplate list pages. */
export function TemplateList({ scope }: { scope: TemplateScope }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const query = useQuery(templateQueries.list(scope, { namePattern: q || undefined }));
  // Creating needs template:create on the namespace (cluster templates: globally).
  const { can } = useActions(scope.cluster ? {} : { namespace: scope.namespace });
  const items = query.data?.items ?? [];

  return (
    <Page>
      <PageHeader
        title={scope.cluster ? t("Cluster templates") : t("Templates")}
        description={scope.cluster ? t("ClusterWorkflowTemplates are shared by every namespace. Runs created from one belong to the namespace they run in.") : t("WorkflowTemplates in this namespace. Permissions are granted on templates; their runs inherit them.")}
        actions={
          can("template:create") && (
            <Button asChild>
              <Link to={scope.cluster ? "/cluster-templates/new" : "/templates/new"}>
                <Plus aria-hidden />
                {t("New template")}
              </Link>
            </Button>
          )
        }
      />
      <label className="relative max-w-sm">
        <span className="sr-only">{t("Search by name")}</span>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search by name")} className="bg-card pl-9" />
      </label>
      {query.error ? (
        <ErrorState error={query.error} />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>{t("Name")}</TableHead>
                  <TableHead>{t("Entrypoint")}</TableHead>
                  <TableHead>{t("Parameters")}</TableHead>
                  <TableHead>{t("Last modified by")}</TableHead>
                  <TableHead>{t("Created")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.isPending &&
                  Array.from({ length: 5 }, (_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={5}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    </TableRow>
                  ))}
                {items.map((tpl) => (
                  <TableRow key={tpl.metadata.uid ?? tpl.metadata.name}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        {scope.cluster ? (
                          <Link to="/cluster-templates/$name" params={{ name: tpl.metadata.name }} className="font-mono text-[13px] font-medium text-primary hover:underline">
                            {tpl.metadata.name}
                          </Link>
                        ) : (
                          <Link to="/templates/$namespace/$name" params={{ namespace: tpl.metadata.namespace, name: tpl.metadata.name }} className="font-mono text-[13px] font-medium text-primary hover:underline">
                            {tpl.metadata.name}
                          </Link>
                        )}
                        {tpl.metadata.labels?.[COMPONENT_LABEL] === "true" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-node-ref-bg px-2 py-0.5 text-[11px] font-semibold text-node-ref">
                            <Layers className="size-3" aria-hidden />
                            {t("Component")}
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{tpl.spec.entrypoint ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{(tpl.spec.arguments?.parameters ?? []).map((p) => p.name).join(", ") || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{tpl.metadata.annotations?.[MODIFIED_BY_ANNOTATION] ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{formatRelative(tpl.metadata.creationTimestamp)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {!query.isPending && items.length === 0 && <EmptyState title={t("No templates")} description={q ? t("Nothing matches this name.") : t("Templates you may see will appear here.")} />}
        </div>
      )}
    </Page>
  );
}
