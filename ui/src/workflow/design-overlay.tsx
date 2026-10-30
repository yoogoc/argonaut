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
  const named = (s: NodeStatus, task: string) => s.displayName === task || s.displayName.startsWith(`${task}(`);
  const leaves = (s: NodeStatus) => s.type !== "TaskGroup" && s.type !== "StepGroup" && s.type !== "Retry";
  // A task inside an expanded group is found by walking its path: each group's runs are the nodes in
  // that group's boundary, so region-eu/fetch and region-us/fetch stay apart.
  const runsAt = (path: string[]): NodeStatus[] => {
    if (path.length > 1) {
      let boundary = root?.id;
      for (const [i, task] of path.entries()) {
        const here = statuses.filter((s) => s.boundaryID === boundary && named(s, task));
        if (i === path.length - 1) return here.filter(leaves);
        boundary = (here.find((s) => s.type === "DAG" || s.type === "Steps") ?? here[0])?.id;
        if (!boundary) return [];
      }
    }
    const task = path[0];
    const runs = statuses.filter((s) => leaves(s) && named(s, task));
    // A single-step entry template is drawn as one node named after the template; it ran as the
    // workflow's root node (or, with a retry strategy, as the root Retry node's attempts).
    if (runs.length || task !== entry || !root || root.templateName !== task) return runs;
    return root.type === "Retry" ? statuses.filter((s) => root.children?.includes(s.id)) : [root];
  };
  return (
    <SpecGraphView
      spec={spec}
      template={entry}
      status={(_task, path) => {
        const runs = runsAt(path);
        return { phase: aggregate(runs), count: runs.filter((r) => r.type === "Pod").length };
      }}
      onSelect={(_task, path) => {
        const last = runsAt(path).sort((a, b) => Date.parse(b.startedAt ?? "") - Date.parse(a.startedAt ?? ""))[0];
        if (last) onSelectNode(last.id);
      }}
    />
  );
}
