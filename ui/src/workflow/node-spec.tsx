import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { ContainerSpec, HttpSpec, NodeStatus, Template, Workflow } from "@/api/types";
import { evaluateExpressions, getRenderedTemplate } from "@/api/workflows";
import { Fields, Mono } from "@/components/common/page";
import { EmptyState } from "@/components/common/states";
import { type ExpressionScope, expressionVariables, pendingExpressions, renderedBindings } from "@/lib/expressions";
import { resolveTemplate, templateContainers, templateKind } from "@/lib/template";
import { toYaml } from "@/lib/yaml";

import { ExprCode, ExpressionContext, ExprList, ExprText } from "./expr-text";
import { useRunSource } from "./run-source";

/**
 * What a node was asked to do, from its resolved template: the image, the script source, the request.
 * The node status only records how it went (see lib/template.ts for the resolution).
 */
export function NodeSpec({ workflow, node }: { workflow: Workflow; node: NodeStatus }) {
  const { t } = useTranslation();
  const template = resolveTemplate(workflow, node);
  const scope = useExpressionScope(workflow, node, template);
  if (!template) return <EmptyState title={t("Template not found")} description={t("The template for this node is not stored in the workflow.")} />;
  const kind = templateKind(template);
  const retry = template.retryStrategy as { limit?: string | number; retryPolicy?: string; backoff?: { duration?: string; factor?: number | string; maxDuration?: string } } | undefined;
  return (
    <ExpressionContext.Provider value={scope}>
      <div className="space-y-5">
        <Fields
          items={[
            [t("Template"), <Mono>{template.name ?? node.templateName ?? "—"}</Mono>],
            [t("Kind"), kind],
            [t("Service account"), template.serviceAccountName ?? "—"],
            ...(retry
              ? ([
                  [
                    t("Retry strategy"),
                    <span>
                      limit <Mono>{String(retry.limit ?? "∞")}</Mono> · <Mono>{retry.retryPolicy ?? "OnFailure"}</Mono>
                      {retry.backoff?.duration && ` · ${t("backoff")} ${retry.backoff.duration}${retry.backoff.factor ? ` ×${retry.backoff.factor}` : ""}`}
                    </span>,
                  ],
                ] as [string, React.ReactNode][])
              : []),
          ]}
        />
        {template.memoize && (
          <Block title={t("Memoization")}>
            <Fields
              items={[
                [t("Key"), <ExprText text={template.memoize.key} />],
                [t("Max age"), template.memoize.maxAge ?? "—"],
                [t("Cache"), template.memoize.cache?.configMap?.name ?? "—"],
              ]}
            />
          </Block>
        )}
        {kind === "http" && template.http && <HttpDetails http={template.http} />}
        {(kind === "container" || kind === "script") && templateContainers(template).map((c, i) => <ContainerDetails key={`${c.name}-${i}`} container={c} />)}
        {kind === "resource" && template.resource && (
          <Block title={t("Resource")}>
            <Fields
              items={[
                [t("Action"), template.resource.action ?? "—"],
                [t("Success condition"), template.resource.successCondition ?? "—"],
                [t("Failure condition"), template.resource.failureCondition ?? "—"],
              ]}
            />
            {template.resource.manifest && <ExprCode text={template.resource.manifest} />}
          </Block>
        )}
        {kind === "data" && template.data && <Code text={toYaml(template.data)} />}
        {kind === "other" && <OtherTemplate template={template} />}
      </div>
    </ExpressionContext.Provider>
  );
}

/**
 * The values behind the node's template variables (lib/expressions.ts). The pod's rendered template is
 * read first, since it holds exactly what ran; expressions it cannot answer for — the pod is gone, or the
 * run is archived — are then estimated by the server from what the run recorded.
 */
function useExpressionScope(workflow: Workflow, node: NodeStatus, template: Template | undefined): ExpressionScope {
  const archived = !!useRunSource().archivedUid;
  const namespace = workflow.metadata.namespace ?? "";
  const name = workflow.metadata.name;
  // The pod exists from Pending on; refetching on each phase picks it up once it is created.
  const podQuery = useQuery({
    queryKey: ["rendered-template", namespace, name, node.id, node.phase],
    queryFn: () => getRenderedTemplate(namespace, name, node.id),
    enabled: !archived && !!template && node.type === "Pod",
    staleTime: Infinity,
    retry: false,
  });
  const rendered = useMemo(() => {
    if (!template || !podQuery.data?.templateJson) return undefined;
    try {
      return renderedBindings(template, JSON.parse(podQuery.data.templateJson));
    } catch {
      return undefined;
    }
  }, [template, podQuery.data]);
  const variables = useMemo(() => expressionVariables(workflow, node), [workflow, node]);
  const podSettled = archived || node.type !== "Pod" || !podQuery.isPending;
  const pending = useMemo(() => (template ? [...pendingExpressions(template, rendered)].sort() : []), [template, rendered]);
  const estimateQuery = useQuery({
    queryKey: ["expression-estimates", namespace, name, node.id, node.phase, pending],
    queryFn: () => evaluateExpressions(pending, variables),
    enabled: podSettled && pending.length > 0,
    staleTime: Infinity,
    retry: false,
  });
  const estimates = useMemo(() => {
    if (!estimateQuery.data) return undefined;
    return new Map(pending.map((expression, i) => [expression, estimateQuery.data[i] ?? {}]));
  }, [estimateQuery.data, pending]);
  return useMemo(() => ({ variables, rendered, estimates }), [variables, rendered, estimates]);
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function ContainerDetails({ container }: { container: ContainerSpec }) {
  const { t } = useTranslation();
  const requests = container.resources?.requests;
  const limits = container.resources?.limits;
  const res = [
    requests &&
      `requests ${Object.entries(requests)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
    limits &&
      `limits ${Object.entries(limits)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Block title={container.sidecar ? t("Sidecar {{name}}", { name: container.name }) : t("Container {{name}}", { name: container.name })}>
      <Fields
        items={[
          [t("Image"), <ExprText text={container.image} />],
          [t("Command"), <ExprList values={container.command} />],
          [t("Args"), <ExprList values={container.args} />],
          [t("Working dir"), <ExprText text={container.workingDir} />],
          [t("Resources"), res || "—"],
        ]}
      />
      {container.source && <ExprCode text={container.source} />}
      {(container.env ?? []).length > 0 && (
        <Fields
          items={(container.env ?? []).map((e) => [
            <Mono>{e.name}</Mono>,
            e.value !== undefined ? (
              <ExprText text={e.value} />
            ) : (
              <span className="text-xs text-muted-foreground">
                {t("from")} {toYaml(e.valueFrom).trim()}
              </span>
            ),
          ])}
        />
      )}
    </Block>
  );
}

function HttpDetails({ http }: { http: HttpSpec }) {
  const { t } = useTranslation();
  return (
    <Block title={t("HTTP request")}>
      <Fields
        items={[
          [t("Method"), http.method ?? "GET"],
          ["URL", <ExprText text={http.url} />],
          [t("Timeout"), http.timeoutSeconds ? `${http.timeoutSeconds}s` : "—"],
          [t("Success condition"), http.successCondition ? <Mono>{http.successCondition}</Mono> : "—"],
          [t("Skip TLS verify"), http.insecureSkipVerify ? t("Yes") : t("No")],
        ]}
      />
      {(http.headers ?? []).length > 0 && (
        <Fields
          items={(http.headers ?? []).map((h) => [
            <Mono>{h.name}</Mono>,
            h.value !== undefined ? <ExprText text={h.value} /> : <span className="text-xs text-muted-foreground">{t("from a secret")}</span>,
          ])}
        />
      )}
      {http.body && <ExprCode text={http.body} />}
    </Block>
  );
}

function OtherTemplate({ template }: { template: Template }) {
  return <Code text={toYaml(template)} />;
}

export function Code({ text, className }: { text: string; className?: string }) {
  return <pre className={`max-h-80 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-relaxed whitespace-pre text-zinc-200 ${className ?? ""}`}>{text}</pre>;
}
