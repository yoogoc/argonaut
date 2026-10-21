import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Layers, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useActions } from "@/api/authz";
import { type Component, templateQueries } from "@/api/templates";
import type { WorkflowTemplate } from "@/api/types";
import { Page, PageHeader } from "@/components/common/page";
import { EmptyState, ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { KindIcon } from "@/graph/kinds";
import { type SpecLike, templateKind } from "@/graph/spec";
import { useNamespace } from "@/hooks/use-namespace";
import { formatRelative } from "@/lib/format";

export const Route = createFileRoute("/_app/components")({ component: ComponentsPage });

const CATEGORY = "argonaut.io/category";
const DESCRIPTION = "argonaut.io/description";

function entry(c: Component): WorkflowTemplate {
  return (c.cluster ? c.clusterTemplate : c.template)!;
}

/** What a component runs: its entry template's kind, which decides the icon. */
function componentKind(tpl: WorkflowTemplate) {
  const spec = tpl.spec as SpecLike;
  return templateKind(spec.templates?.find((t) => t.name === spec.entrypoint) ?? spec.templates?.[0]);
}

function ComponentsPage() {
  const { t } = useTranslation();
  const { namespace } = useNamespace();
  const query = useQuery(templateQueries.components(namespace));
  const { can } = useActions({ namespace });
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const components = useMemo(() => query.data ?? [], [query.data]);
  const categories = [...new Set(components.map((c) => entry(c).metadata.annotations?.[CATEGORY]).filter(Boolean) as string[])].sort();
  const shown = components.filter((c) => {
    const tpl = entry(c);
    if (category !== "all" && tpl.metadata.annotations?.[CATEGORY] !== category) return false;
    if (!q) return true;
    const hay = [tpl.metadata.name, tpl.metadata.annotations?.[DESCRIPTION] ?? "", ...(tpl.spec.arguments?.parameters ?? []).map((p) => p.name)].join(" ").toLowerCase();
    return hay.includes(q.toLowerCase());
  });
  const clusterCount = components.filter((c) => c.cluster).length;

  return (
    <Page>
      <PageHeader
        title={t("Components")}
        description={
          <>
            {t("WorkflowTemplates and ClusterWorkflowTemplates labelled")} <span className="font-mono">argonaut.io/component=true</span>
            {t(", which the editor can reference or copy in.")}
          </>
        }
        actions={
          can("template:create") && (
            <Button asChild>
              <Link to="/templates/new" search={{ component: true }}>
                <Plus aria-hidden />
                {t("New component")}
              </Link>
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative w-full max-w-xs">
          <span className="sr-only">{t("Search components")}</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search name, parameters")} className="bg-card pl-9" />
        </label>
        {categories.length > 0 && (
          <ToggleGroup type="single" variant="outline" size="sm" value={category} onValueChange={(v) => v && setCategory(v)} aria-label={t("Category")}>
            <ToggleGroupItem value="all" className="px-3">
              {t("All")}
            </ToggleGroupItem>
            {categories.map((c) => (
              <ToggleGroupItem key={c} value={c} className="px-3">
                {c}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <span className="ml-auto text-[13px] text-muted-foreground">
          {t("{{namespace}}: {{local}} · cluster: {{cluster}}", { namespace, local: components.length - clusterCount, cluster: clusterCount })}
        </span>
      </div>
      {query.error ? (
        <ErrorState error={query.error} />
      ) : query.isPending ? (
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(300px, 100%), 1fr))" }}>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-48 rounded-xl" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState title={t("No components")} description={t("Label a template argonaut.io/component=true to make it a component.")} />
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(300px, 100%), 1fr))" }}>
          {shown.map((c) => {
            const tpl = entry(c);
            const spec = tpl.spec as SpecLike;
            const entryTpl = spec.templates?.find((x) => x.name === spec.entrypoint) as { inputs?: { parameters?: { name: string }[] }; outputs?: { parameters?: { name: string }[]; artifacts?: { name: string }[] } } | undefined;
            const inputs = [...(tpl.spec.arguments?.parameters ?? []).map((p) => p.name), ...(entryTpl?.inputs?.parameters ?? []).map((p) => p.name)];
            const outputs = [...(entryTpl?.outputs?.parameters ?? []).map((p) => p.name), ...(entryTpl?.outputs?.artifacts ?? []).map((a) => a.name)];
            return (
              <article key={`${c.cluster}/${tpl.metadata.name}`} className="flex flex-col gap-3.5 rounded-xl border bg-card p-4">
                <div className="flex items-start gap-3">
                  <KindIcon kind={componentKind(tpl)} className="size-9" />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <h2 className="truncate font-mono text-sm font-semibold">
                      {c.cluster ? (
                        <Link to="/cluster-templates/$name" params={{ name: tpl.metadata.name }} className="hover:underline">
                          {tpl.metadata.name}
                        </Link>
                      ) : (
                        <Link to="/templates/$namespace/$name" params={{ namespace: tpl.metadata.namespace, name: tpl.metadata.name }} className="hover:underline">
                          {tpl.metadata.name}
                        </Link>
                      )}
                    </h2>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {tpl.metadata.annotations?.[CATEGORY] ?? t("Uncategorised")}
                      {c.cluster && <span className="rounded-full bg-foreground px-1.5 text-[10px] font-bold text-background">{t("Cluster")}</span>}
                    </span>
                  </div>
                  <span className={c.editable ? "ml-auto rounded-full bg-node-script-bg px-2 py-0.5 text-[11px] font-semibold text-node-script" : "ml-auto rounded-full bg-phase-ok-bg px-2 py-0.5 text-[11px] font-semibold text-phase-ok"}>
                    {c.editable ? t("Editable") : t("Usable")}
                  </span>
                </div>
                <p className="min-h-10 text-[13px] leading-relaxed text-muted-foreground">{tpl.metadata.annotations?.[DESCRIPTION] ?? t("No description.")}</p>
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="w-8 text-[11px] font-semibold text-muted-foreground">{t("In")}</span>
                    {inputs.length ? inputs.map((p) => <span key={p} className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px]">{p}</span>) : <span className="text-xs text-muted-foreground">—</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="w-8 text-[11px] font-semibold text-muted-foreground">{t("Out")}</span>
                    {outputs.length ? outputs.map((p) => <span key={p} className="rounded-md bg-node-ref-bg px-2 py-0.5 font-mono text-[11px] text-node-ref">{p}</span>) : <span className="text-xs text-muted-foreground">—</span>}
                  </div>
                </div>
                <div className="mt-auto flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
                  <Layers className="size-3.5" aria-hidden />
                  <span>{t("Updated {{when}}", { when: formatRelative(tpl.metadata.creationTimestamp) })}</span>
                  <Link to="/templates/new" search={{ from: `${c.cluster ? "cluster" : namespace}/${tpl.metadata.name}` }} className="ml-auto text-[13px] font-medium text-primary hover:underline">
                    {t("Use in editor")}
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </Page>
  );
}
