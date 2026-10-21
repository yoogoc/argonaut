import { useTranslation } from "react-i18next";

import type { Workflow } from "@/api/types";
import { Fields, Mono, Section } from "@/components/common/page";
import { PhaseBadge } from "@/components/common/phase-badge";
import { EmptyState } from "@/components/common/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ArtifactRef } from "@/graph/runtime";
import { useNow } from "@/hooks/use-now";
import { formatDuration, formatTimestamp, resourcesDuration } from "@/lib/format";
import { isSuspended } from "@/lib/workflow";

// Read-only tabs of a run's detail page, shared by live and archived runs.

/** `?artifact=in|out:<nodeId>/<name>` */
export function parseArtifactParam(value?: string): ArtifactRef | undefined {
  if (!value) return undefined;
  const m = value.match(/^(in|out):([^/]+)\/(.+)$/);
  return m ? { isInput: m[1] === "in", nodeId: m[2], name: m[3] } : undefined;
}

export function SummaryTab({ workflow }: { workflow: Workflow }) {
  const { t } = useTranslation();
  const now = useNow(workflow.status?.phase === "Running");
  return (
    <div className="grid gap-4 overflow-auto p-4 lg:grid-cols-2">
      <Section title={t("Summary")} bodyClassName="p-4">
        <Fields
          items={[
            [t("Phase"), <PhaseBadge phase={workflow.status?.phase} suspended={isSuspended(workflow)} />],
            [t("Message"), workflow.status?.message ?? "—"],
            [t("Started"), formatTimestamp(workflow.status?.startedAt)],
            [t("Finished"), formatTimestamp(workflow.status?.finishedAt)],
            [t("Duration"), formatDuration(workflow.status?.startedAt, workflow.status?.finishedAt, now)],
            [t("Progress"), workflow.status?.progress ?? "—"],
            [t("Resources"), resourcesDuration(workflow.status?.resourcesDuration)],
            [t("Entrypoint"), <Mono>{workflow.spec.entrypoint ?? "—"}</Mono>],
            [t("Service account"), workflow.spec.serviceAccountName ?? "—"],
          ]}
        />
      </Section>
      <Section title={t("Conditions")} bodyClassName="p-4">
        {(workflow.status?.conditions ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("No conditions reported.")}</p>
        ) : (
          <Fields items={(workflow.status?.conditions ?? []).map((c) => [c.type, `${c.status}${c.message ? ` — ${c.message}` : ""}`])} />
        )}
      </Section>
      <Section title={t("Labels")} bodyClassName="p-4">
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(workflow.metadata.labels ?? {}).map(([k, v]) => (
            <span key={k} className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs">
              {k}={v}
            </span>
          ))}
        </div>
      </Section>
      <Section title={t("Annotations")} bodyClassName="p-4">
        <Fields items={Object.entries(workflow.metadata.annotations ?? {}).map(([k, v]) => [<Mono className="text-xs">{k}</Mono>, <Mono className="break-all text-xs">{v}</Mono>])} />
      </Section>
    </div>
  );
}

export function ParametersTab({ workflow }: { workflow: Workflow }) {
  const { t } = useTranslation();
  const params = workflow.spec.arguments?.parameters ?? [];
  const outputs = workflow.status?.outputs?.parameters ?? [];
  return (
    <div className="grid gap-4 p-4 lg:grid-cols-2">
      <Section title={t("Arguments")} bodyClassName="p-4">
        {params.length ? <Fields items={params.map((p) => [<Mono>{p.name}</Mono>, <Mono className="break-all text-xs">{p.value ?? p.default ?? ""}</Mono>])} /> : <p className="text-sm text-muted-foreground">{t("This workflow takes no parameters.")}</p>}
      </Section>
      <Section title={t("Global outputs")} bodyClassName="p-4">
        {outputs.length ? <Fields items={outputs.map((p) => [<Mono>{p.name}</Mono>, <Mono className="break-all text-xs">{p.value ?? ""}</Mono>])} /> : <p className="text-sm text-muted-foreground">{t("No global outputs.")}</p>}
      </Section>
    </div>
  );
}

export function ArtifactsTab({ workflow, onSelect }: { workflow: Workflow; onSelect: (ref: ArtifactRef) => void }) {
  const { t } = useTranslation();
  const rows = Object.values(workflow.status?.nodes ?? {})
    .filter((n) => n.type === "Pod")
    .flatMap((n) => [
      ...(n.inputs?.artifacts ?? []).map((a) => ({ node: n, artifact: a, isInput: true })),
      ...(n.outputs?.artifacts ?? []).map((a) => ({ node: n, artifact: a, isInput: false })),
    ]);
  if (!rows.length) return <EmptyState title={t("No artifacts")} />;
  return (
    <div className="p-4">
      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>{t("Artifact")}</TableHead>
              <TableHead>{t("Direction")}</TableHead>
              <TableHead>{t("Node")}</TableHead>
              <TableHead>{t("Path")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ node, artifact, isInput }) => (
              <TableRow key={`${node.id}/${isInput}/${artifact.name}`} className="cursor-pointer" onClick={() => onSelect({ nodeId: node.id, name: artifact.name, isInput })}>
                <TableCell className="font-mono text-[13px] text-primary">{artifact.name}</TableCell>
                <TableCell>{isInput ? t("Input") : t("Output")}</TableCell>
                <TableCell className="font-mono text-xs">{node.displayName}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{artifact.path ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
