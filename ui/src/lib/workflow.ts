import type { Artifact, NodePhase, NodeStatus, Workflow } from "@/api/types";

/** Phases Argo considers finished. */
const TERMINAL: NodePhase[] = ["Succeeded", "Failed", "Error", "Omitted", "Skipped"];

export const isRunning = (wf?: Workflow) =>
  wf?.status?.phase === "Running" || wf?.status?.phase === "Pending";

export const isFinished = (wf?: Workflow) =>
  !!wf?.status?.phase && TERMINAL.includes(wf.status.phase);

/** A workflow is suspended when any of its suspend nodes is still waiting. */
export function isSuspended(wf?: Workflow): boolean {
  const nodes = wf?.status?.nodes;
  if (!nodes) return false;
  return Object.values(nodes).some(
    (node) => node.type === "Suspend" && node.phase === "Running",
  );
}

/** The nodes a user can supply values for and release. */
export function suspendedNodes(wf?: Workflow): NodeStatus[] {
  const nodes = wf?.status?.nodes;
  if (!nodes) return [];
  return Object.values(nodes).filter((n) => n.type === "Suspend" && n.phase === "Running");
}

export type OperationName =
  | "RETRY"
  | "RESUBMIT"
  | "SUSPEND"
  | "RESUME"
  | "STOP"
  | "TERMINATE"
  | "DELETE";

/** The permission action each operation needs, matching the server's authz vocabulary. */
export const operationAction: Record<OperationName, string> = {
  RETRY: "workflow:retry",
  RESUBMIT: "workflow:resubmit",
  SUSPEND: "workflow:suspend",
  RESUME: "workflow:resume",
  STOP: "workflow:stop",
  TERMINATE: "workflow:terminate",
  DELETE: "workflow:delete",
};

/**
 * Whether an operation is unavailable for a workflow's current state. These rules mirror Argo's own
 * workflow-operations-map so a button is greyed out for the same reasons as in the official console,
 * rather than failing at the API.
 */
export function isOperationDisabled(name: OperationName, wf?: Workflow): boolean {
  const phase = wf?.status?.phase;
  switch (name) {
    case "RETRY":
      // Argo only retries a workflow that ended badly; retrying a success needs explicit options.
      return !(phase === "Failed" || phase === "Error");
    case "RESUBMIT":
      return false;
    case "SUSPEND":
      return !isRunning(wf) || isSuspended(wf);
    case "RESUME":
      return !isSuspended(wf);
    case "STOP":
    case "TERMINATE":
      return !isRunning(wf);
    case "DELETE":
      return false;
  }
}

/** The template a workflow came from; this is also what its permissions are attributed to. */
export function sourceTemplate(wf: Workflow): string | undefined {
  // A ClusterWorkflowTemplate is not a template of this namespace; callers show it separately.
  const ref = wf.spec?.workflowTemplateRef;
  return (
    (ref?.clusterScope ? undefined : ref?.name) ??
    wf.metadata.labels?.["workflows.argoproj.io/workflow-template"]
  );
}

export function cronParent(wf: Workflow): string | undefined {
  return wf.metadata.labels?.["workflows.argoproj.io/cron-workflow"];
}

/** Sorts nodes the way the graph and lists want them: by start time, then name. */
export function sortNodes(nodes: NodeStatus[]): NodeStatus[] {
  return [...nodes].sort((a, b) => {
    const at = a.startedAt ? Date.parse(a.startedAt) : 0;
    const bt = b.startedAt ? Date.parse(b.startedAt) : 0;
    return at === bt ? a.displayName.localeCompare(b.displayName) : at - bt;
  });
}

/**
 * Derives the pod name for a node.
 *
 * Argo v2 names pods after the node id; from v3.4 the default is
 * `<workflow>-<template>-<hash-suffix-of-node-id>`. The annotation records which scheme the
 * controller used, and the node id is always the trailing hash in the new scheme, so reading the
 * annotation is the only reliable way to address a pod's logs.
 */
export function podName(wf: Workflow, node: NodeStatus): string {
  const version = wf.metadata.annotations?.["workflows.argoproj.io/pod-name-format"];
  if (version === "v1") return node.id;
  if (node.name === wf.metadata.name) return node.name;
  const template = node.templateName || node.templateRef?.template || "";
  const suffix = node.id.split("-").pop() ?? node.id;
  return [wf.metadata.name, template, suffix].filter(Boolean).join("-");
}

/** A node that has stopped, whatever the outcome — the precondition for retrying it. */
export function isNodeFinished(node: NodeStatus): boolean {
  return !!node.phase && TERMINAL.includes(node.phase);
}

/** Nodes that run a pod, which are the only ones with logs and containers. */
export const isPodNode = (node: NodeStatus) => node.type === "Pod";

/**
 * Argo stores each container's log as an artifact alongside the real outputs. The graph is about the
 * data a run produced, and every pod has one of these, so including them would add a node per step
 * that tells the reader nothing. Logs are read through the Logs tab instead.
 */
const LOG_ARTIFACT_NAMES = new Set(["main-logs", "main.log"]);

export function isLogArtifact(artifact: Artifact): boolean {
  if (LOG_ARTIFACT_NAMES.has(artifact.name)) return true;
  // A template may rename the artifact, so fall back to the stored file name Argo writes.
  const key = artifact.s3?.key ?? artifact.gcs?.key ?? artifact.oss?.key ?? artifact.azure?.blob;
  return !!key && key.endsWith("main.log");
}

/** Where an artifact is stored, for display. Argo reports exactly one backend per artifact. */
export function artifactLocation(artifact: Artifact): { store: string; path: string } | undefined {
  if (artifact.s3) return { store: "S3", path: joinLocation(artifact.s3.bucket, artifact.s3.key) };
  if (artifact.gcs) return { store: "GCS", path: joinLocation(artifact.gcs.bucket, artifact.gcs.key) };
  if (artifact.oss) return { store: "OSS", path: joinLocation(artifact.oss.bucket, artifact.oss.key) };
  if (artifact.azure)
    return { store: "Azure", path: joinLocation(artifact.azure.container, artifact.azure.blob) };
  if (artifact.http?.url) return { store: "HTTP", path: artifact.http.url };
  if (artifact.git?.repo) return { store: "Git", path: artifact.git.repo };
  if (artifact.raw) return { store: "Inline", path: "raw value" };
  return undefined;
}

function joinLocation(bucket?: string, key?: string): string {
  return bucket ? `${bucket}/${key ?? ""}` : (key ?? "");
}

/**
 * A stable identity for the stored object, used to recognise that one step's input is another step's
 * output. Argo records the same storage key on both sides, while the artifact *names* differ (a step
 * may consume `output_data` under the name `input_data`), so the key is the only reliable link.
 */
export function artifactKey(artifact: Artifact): string | undefined {
  const location = artifactLocation(artifact);
  if (!location || !location.path) return undefined;
  return `${location.store}:${location.path}`;
}

/** How Argo packaged the artifact, which decides what a download actually contains. */
export function artifactArchive(artifact: Artifact): string {
  if (artifact.archive?.none) return "none (raw file)";
  if (artifact.archive?.zip) return "zip";
  if (artifact.archive?.tar) return "tar.gz";
  // Argo's default for a directory is tar.gz; a single file is stored as-is.
  return "default";
}
