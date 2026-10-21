import { useTranslation } from "react-i18next";

import type { ContainerSpec, HttpSpec, NodeStatus, Template, Workflow } from "@/api/types";
import { Fields, Mono } from "@/components/common/page";
import { EmptyState } from "@/components/common/states";
import { resolveTemplate, templateContainers, templateKind } from "@/lib/template";
import { toYaml } from "@/lib/yaml";

/**
 * What a node was asked to do, from its resolved template: the image, the script source, the request.
 * The node status only records how it went (see lib/template.ts for the resolution).
 */
export function NodeSpec({ workflow, node }: { workflow: Workflow; node: NodeStatus }) {
  const { t } = useTranslation();
  const template = resolveTemplate(workflow, node);
  if (!template) return <EmptyState title={t("Template not found")} description={t("The template for this node is not stored in the workflow.")} />;
  const kind = templateKind(template);
  const retry = template.retryStrategy as { limit?: string | number; retryPolicy?: string; backoff?: { duration?: string; factor?: number | string; maxDuration?: string } } | undefined;
  return (
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
              [t("Key"), <Mono className="break-all">{template.memoize.key ?? "—"}</Mono>],
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
          {template.resource.manifest && <Code text={template.resource.manifest} />}
        </Block>
      )}
      {kind === "data" && template.data && <Code text={toYaml(template.data)} />}
      {kind === "other" && <OtherTemplate template={template} />}
    </div>
  );
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
  const res = [requests && `requests ${Object.entries(requests).map(([k, v]) => `${k}=${v}`).join(", ")}`, limits && `limits ${Object.entries(limits).map(([k, v]) => `${k}=${v}`).join(", ")}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <Block title={container.sidecar ? t("Sidecar {{name}}", { name: container.name }) : t("Container {{name}}", { name: container.name })}>
      <Fields
        items={[
          [t("Image"), container.image ? <Mono>{container.image}</Mono> : "—"],
          [t("Command"), <Args values={container.command} />],
          [t("Args"), <Args values={container.args} />],
          [t("Working dir"), container.workingDir ?? "—"],
          [t("Resources"), res || "—"],
        ]}
      />
      {container.source && <Code text={container.source} />}
      {(container.env ?? []).length > 0 && (
        <Fields
          items={(container.env ?? []).map((e) => [
            <Mono>{e.name}</Mono>,
            e.value !== undefined ? <Mono className="break-all">{e.value}</Mono> : <span className="text-xs text-muted-foreground">{t("from")} {toYaml(e.valueFrom).trim()}</span>,
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
          ["URL", http.url ? <Mono className="break-all">{http.url}</Mono> : "—"],
          [t("Timeout"), http.timeoutSeconds ? `${http.timeoutSeconds}s` : "—"],
          [t("Success condition"), http.successCondition ? <Mono>{http.successCondition}</Mono> : "—"],
          [t("Skip TLS verify"), http.insecureSkipVerify ? t("Yes") : t("No")],
        ]}
      />
      {(http.headers ?? []).length > 0 && (
        <Fields items={(http.headers ?? []).map((h) => [<Mono>{h.name}</Mono>, h.value !== undefined ? <Mono className="break-all">{h.value}</Mono> : <span className="text-xs text-muted-foreground">{t("from a secret")}</span>])} />
      )}
      {http.body && <Code text={http.body} />}
    </Block>
  );
}

function OtherTemplate({ template }: { template: Template }) {
  return <Code text={toYaml(template)} />;
}

function Args({ values }: { values?: string[] }) {
  if (!values?.length) return <>—</>;
  return <Mono className="break-all">{values.map((v) => (/\s/.test(v) ? JSON.stringify(v) : v)).join(" ")}</Mono>;
}

export function Code({ text, className }: { text: string; className?: string }) {
  return <pre className={`max-h-80 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-relaxed whitespace-pre text-zinc-200 ${className ?? ""}`}>{text}</pre>;
}
