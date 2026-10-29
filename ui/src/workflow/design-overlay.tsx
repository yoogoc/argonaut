import { useMemo } from "react";

import type { NodeStatus, Workflow } from "@/api/types";
import type { SpecLike } from "@/graph/spec";
import { SpecGraphView } from "@/graph/spec-view";

/** The phase a task reached across all its runs (fan-out items, retries): failure wins, then running. */
export function aggregate(runs: NodeStatus[]): string | undefined {
  if (!runs.length) return undefined;
  if (runs.some((r) => r.phase === "Failed" || r.phase === "Error")) return "Failed";
  if (runs.some((r) => r.phase === "Running")) return "Running";
  if (runs.every((r) => r.phase === "Succeeded" || r.phase === "Skipped" || r.phase === "Omitted")) return runs.some((r) => r.phase === "Succeeded") ? "Succeeded" : "Skipped";
  return "Pending";
}

/** The template's DAG as designed, each task coloured by how this run went (DESIGN §3.5). */
export function DesignOverlay({ workflow, onSelectNode }: { workflow: Workflow; onSelectNode: (id: string) => void }) {
  const spec = (workflow.status?.storedWorkflowTemplateSpec?.templates?.length ? workflow.status.storedWorkflowTemplateSpec : workflow.spec) as SpecLike;
  const statuses = useMemo(() => Object.values(workflow.status?.nodes ?? {}), [workflow.status?.nodes]);
  const entry = spec.entrypoint ?? workflow.spec.entrypoint;
  const root = workflow.status?.nodes?.[workflow.metadata.name];
  const runsOf = (task: string) => {
    const runs = statuses.filter((s) => s.type !== "TaskGroup" && s.type !== "StepGroup" && s.type !== "Retry" && (s.displayName === task || s.displayName.startsWith(`${task}(`)));
    // A single-step entry template is drawn as one node named after the template; it ran as the
    // workflow's root node (or, with a retry strategy, as the root Retry node's attempts).
    if (runs.length || task !== entry || !root || root.templateName !== task) return runs;
    return root.type === "Retry" ? statuses.filter((s) => root.children?.includes(s.id)) : [root];
  };
  return (
    <SpecGraphView
      spec={spec}
      template={entry}
      status={(task) => {
        const runs = runsOf(task);
        return { phase: aggregate(runs), count: runs.filter((r) => r.type === "Pod").length };
      }}
      onSelect={(task) => {
        const last = runsOf(task).sort((a, b) => Date.parse(b.startedAt ?? "") - Date.parse(a.startedAt ?? ""))[0];
        if (last) onSelectNode(last.id);
      }}
    />
  );
}
