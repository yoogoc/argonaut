import { Download, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Artifact, NodeStatus, Workflow } from "@/api/types";
import { Fields, Mono } from "@/components/common/page";
import { PhaseBadge, phaseTone } from "@/components/common/phase-badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useNow } from "@/hooks/use-now";
import { formatDuration, formatTimestamp, resourcesDuration } from "@/lib/format";
import { resolveTemplate, templateContainers } from "@/lib/template";
import { cn } from "@/lib/utils";
import { isNodeFinished, isPodNode, podName } from "@/lib/workflow";
import { toYaml } from "@/lib/yaml";

import { LogViewer } from "./log-viewer";
import { Code, NodeSpec } from "./node-spec";
import { useArtifactHref } from "./run-source";

/**
 * The node inspector. A node that belongs to a Retry shows its attempts as a switcher, and every tab
 * below follows the selected attempt — each attempt is its own pod with its own logs.
 */
export function NodePanel({
  workflow,
  node,
  onClose,
  onRetryNode,
  onSelectNode,
  canRetry,
}: {
  workflow: Workflow;
  node: NodeStatus;
  onClose: () => void;
  onRetryNode: (node: NodeStatus) => void;
  onSelectNode: (node: NodeStatus) => void;
  canRetry: boolean;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState(isPodNode(node) && node.phase === "Running" ? "logs" : "info");
  const nodes = workflow.status?.nodes ?? {};
  const retryParent = Object.values(nodes).find((n) => n.type === "Retry" && n.children?.includes(node.id));
  const attempts = retryParent
    ? (retryParent.children ?? [])
        .map((id) => nodes[id])
        .filter(Boolean)
        .sort((a, b) => Date.parse(a.startedAt ?? "") - Date.parse(b.startedAt ?? ""))
    : [];
  const template = resolveTemplate(workflow, node);
  const retry = template?.retryStrategy as { limit?: number | string; retryPolicy?: string; backoff?: { duration?: string; factor?: string | number } } | undefined;
  const running = node.phase === "Running" || node.phase === "Pending";
  const now = useNow(running);
  const containers = templateContainers(template).map((c) => c.name ?? "main");
  const logContainers = containers.length ? [...containers, "init", "wait"] : ["main", "init", "wait"];

  return (
    <aside aria-label={t("Node details")} className="flex h-full min-h-0 w-full flex-col border-l bg-card lg:w-[480px] lg:shrink-0">
      <div className="flex flex-col gap-3 px-5 pt-4">
        <div className="flex items-center gap-2.5">
          <h2 className="min-w-0 truncate font-mono text-base font-semibold">{node.displayName || node.name}</h2>
          <PhaseBadge phase={node.phase} />
          <div className="ml-auto flex gap-1">
            {canRetry && isNodeFinished(node) && (
              <Button variant="outline" size="sm" onClick={() => onRetryNode(retryParent ?? node)}>
                <RotateCcw aria-hidden />
                {t("Retry node")}
              </Button>
            )}
            <Button variant="ghost" size="icon" className="size-8" onClick={onClose} aria-label={t("Close node details")}>
              <X aria-hidden />
            </Button>
          </div>
        </div>
        <Fields
          className="text-[13px]"
          items={[
            [t("Template"), <Mono>{node.templateName ?? node.templateRef?.template ?? "—"}</Mono>],
            ...(isPodNode(node) ? ([[t("Pod"), <Mono className="text-xs">{podName(workflow, node)}</Mono>]] as [string, React.ReactNode][]) : []),
            [t("Duration"), <span className="font-mono">{formatDuration(node.startedAt, node.finishedAt, now)}</span>],
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
        {attempts.length > 1 && (
          <div role="group" aria-label={t("Choose attempt")} className="grid grid-cols-2 gap-2">
            {attempts.map((a, i) => {
              const tone = phaseTone(a.phase);
              const prev = attempts[i - 1];
              const backoff = prev?.finishedAt && a.startedAt ? Math.round((Date.parse(a.startedAt) - Date.parse(prev.finishedAt)) / 1000) : undefined;
              return (
                <button
                  key={a.id}
                  type="button"
                  aria-pressed={a.id === node.id}
                  onClick={() => onSelectNode(a)}
                  className={cn(
                    "flex flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors",
                    a.id === node.id ? "border-2 border-primary bg-primary/5" : tone === "fail" ? "border-phase-fail-solid/40 bg-phase-fail-bg/50" : "hover:bg-accent",
                  )}
                >
                  <span className={cn("text-[13px] font-semibold", tone === "fail" ? "text-phase-fail" : tone === "run" ? "text-phase-run" : "")}>
                    {t("Attempt {{n}}", { n: i + 1 })} · {t(a.phase ?? "Pending")}
                  </span>
                  <span className="text-muted-foreground">
                    {tone === "fail" && a.message ? `${a.message.slice(0, 40)} · ` : ""}
                    {backoff !== undefined && backoff > 0 ? `${t("after {{s}}s backoff", { s: backoff })} · ` : ""}
                    {formatDuration(a.startedAt, a.finishedAt, now)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <Tabs value={tab} onValueChange={setTab} className="mt-3 flex min-h-0 flex-1 flex-col gap-0">
        <TabsList variant="line" className="w-full justify-start gap-4 border-b px-5">
          <TabsTrigger value="info">{t("Info")}</TabsTrigger>
          <TabsTrigger value="spec">{t("Spec")}</TabsTrigger>
          {isPodNode(node) && <TabsTrigger value="logs">{t("Logs")}</TabsTrigger>}
          <TabsTrigger value="manifest">{t("Manifest")}</TabsTrigger>
        </TabsList>
        <TabsContent value="info" className="min-h-0 flex-1 overflow-auto p-5">
          <NodeInfo workflow={workflow} node={node} />
        </TabsContent>
        <TabsContent value="spec" className="min-h-0 flex-1 overflow-auto p-5">
          <NodeSpec workflow={workflow} node={node} />
        </TabsContent>
        {isPodNode(node) && (
          <TabsContent value="logs" className="flex min-h-0 flex-1 flex-col p-4">
            <LogViewer workflow={workflow} podName={podName(workflow, node)} nodeId={node.id} containers={logContainers} running={running} />
          </TabsContent>
        )}
        <TabsContent value="manifest" className="min-h-0 flex-1 overflow-auto p-5">
          <Code text={toYaml(node)} className="max-h-none" />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function NodeInfo({ workflow, node }: { workflow: Workflow; node: NodeStatus }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-5">
      <Fields
        items={[
          [t("Node ID"), <Mono className="text-xs">{node.id}</Mono>],
          [t("Type"), node.type],
          [t("Started"), formatTimestamp(node.startedAt)],
          [t("Finished"), formatTimestamp(node.finishedAt)],
          [t("Host"), node.hostNodeName ? <Mono>{node.hostNodeName}</Mono> : "—"],
          [t("Resources"), resourcesDuration(node.resourcesDuration)],
          ...(node.memoizationStatus
            ? ([
                [t("Memoization"), node.memoizationStatus.hit ? t("Cache hit — this step was skipped and its outputs reused") : t("Cache miss — this step ran and its outputs were cached")],
                [t("Cache key"), <Mono className="break-all text-xs">{node.memoizationStatus.key ?? "—"}</Mono>],
              ] as [string, React.ReactNode][])
            : []),
          [t("Message"), node.message ?? "—"],
        ]}
      />
      <Params title={t("Inputs")} params={node.inputs?.parameters} />
      <Artifacts title={t("Input artifacts")} workflow={workflow} node={node} artifacts={node.inputs?.artifacts} isInput />
      <Params title={t("Outputs")} params={node.outputs?.parameters} />
      <Artifacts title={t("Output artifacts")} workflow={workflow} node={node} artifacts={node.outputs?.artifacts} />
      {node.outputs?.result && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground">{t("Result")}</h3>
          <Code text={node.outputs.result} className="max-h-40" />
        </section>
      )}
      {node.outputs?.exitCode !== undefined && <Fields items={[[t("Exit code"), <Mono>{node.outputs.exitCode}</Mono>]]} />}
    </div>
  );
}

function Params({ title, params }: { title: string; params?: { name: string; value?: string }[] }) {
  if (!params?.length) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <Fields items={params.map((p) => [<Mono>{p.name}</Mono>, <Mono className="break-all text-xs">{p.value ?? ""}</Mono>])} />
    </section>
  );
}

function Artifacts({ title, workflow, node, artifacts, isInput = false }: { title: string; workflow: Workflow; node: NodeStatus; artifacts?: Artifact[]; isInput?: boolean }) {
  const artifactHref = useArtifactHref();
  if (!artifacts?.length) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <ul className="space-y-1 text-sm">
        {artifacts.map((a) => (
          <li key={a.name}>
            <a className="inline-flex items-center gap-1.5 text-primary hover:underline" href={artifactHref(workflow, node.id, a.name, isInput)}>
              <Download className="size-3.5" aria-hidden />
              <span className="font-mono">{a.name}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
