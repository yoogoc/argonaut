import argoSchema from "@/api/gen/argo-schema.json";
import type { NodeKind } from "@/graph/spec";

import type { Path } from "../doc";

// The config panel's field definitions (DESIGN §3.7): every field the panel shows, its control, and
// where it lives. Paths are relative to a base — the task, the template, the template's main
// container, or the workflow spec. Anything Argo's schema has that is not listed here is added
// automatically under "Other fields" (see uncovered()), so an Argo upgrade cannot hide a field.

export type Base = "task" | "template" | "container" | "spec";

export type Control =
  | "text"
  | "number"
  | "select"
  | "switch"
  | "expression"
  | "list"
  | "kv-map"
  | "kv-list"
  | "objects"
  | "resources"
  | "code"
  | "yaml"
  | "note"
  | "loop"
  | "template-ref";

export interface FieldDef {
  label: string;
  base: Base;
  path: Path;
  control: Control;
  options?: string[];
  placeholder?: string;
  hint?: string;
  /** For object lists: which sub-fields each item has (shown under the list). */
  sub?: string;
  /** For kv-list: the key and value property names, e.g. ["name", "value"]. */
  kv?: [string, string];
  /** For objects: a new item's starting value. */
  item?: unknown;
  /** For objects: how to summarise one item in its row. */
  summary?: (item: Record<string, unknown>) => string;
  language?: "yaml" | "python" | "shell" | "json";
}

export interface SectionDef {
  title: string;
  hint?: string;
  fields: FieldDef[];
}

export interface TabDef {
  id: string;
  label: string;
  sections: SectionDef[];
  /** Renders the YAML of the selection instead of fields. */
  yaml?: boolean;
}

const f = (label: string, base: Base, path: Path, control: Control, extra: Partial<FieldDef> = {}): FieldDef => ({ label, base, path, control, ...extra });
const name = (i: Record<string, unknown>) => String(i.name ?? i.key ?? "");

// ---------- task (DAG task / step) ----------

export function taskSections(isRef: boolean): SectionDef[] {
  return [
    {
      title: "Basics",
      fields: [
        f("Task name", "task", ["name"], "text"),
        isRef ? f("Template", "task", ["templateRef"], "template-ref") : f("Template", "task", ["template"], "text", { hint: "A template of this spec. Switch to a component by dragging one onto the canvas." }),
        f("Depends", "task", ["depends"], "expression", { placeholder: "a.Succeeded && (b || c)", hint: "Conditions: Succeeded, Failed, Errored, Skipped, Omitted, Daemoned, AnySucceeded, AllFailed" }),
        f("Dependencies (legacy)", "task", ["dependencies"], "list", { hint: "Older syntax; use depends instead." }),
        f("When", "task", ["when"], "expression", { placeholder: "{{workflow.parameters.env}} == prod" }),
      ],
    },
    {
      title: "Loop",
      fields: [f("Loop", "task", [], "loop", { hint: "withItems: a fixed list · withParam: a JSON array from an expression · withSequence: a numeric range" })],
    },
    {
      title: "Arguments",
      fields: [
        f("Parameters", "task", ["arguments", "parameters"], "kv-list", { kv: ["name", "value"], sub: "Each: name, value or valueFrom (configMapKeyRef / expression)" }),
        f("Artifacts", "task", ["arguments", "artifacts"], "objects", { item: { name: "input", from: "" }, summary: (i) => `${name(i)} ← ${String(i.from ?? i.fromExpression ?? "location")}`, sub: "Each: name, from / fromExpression, or a storage location" }),
      ],
    },
    {
      title: "Failure and exit",
      fields: [
        f("Continue on failure", "task", ["continueOn", "failed"], "switch"),
        f("Continue on error", "task", ["continueOn", "error"], "switch"),
        f("Task exit handler", "task", ["onExit"], "text", { placeholder: "template name" }),
        f("Lifecycle hooks", "task", ["hooks"], "yaml", { hint: "Event expression → template / templateRef, with arguments", placeholder: "running:\n  expression: tasks.x.status == \"Running\"\n  template: notify" }),
      ],
    },
  ];
}

// ---------- container fields (container, script, sidecars) ----------

export function containerSections(script: boolean): SectionDef[] {
  return [
    {
      title: "Image and command",
      fields: [
        f("Image", "container", ["image"], "text"),
        f("Pull policy", "container", ["imagePullPolicy"], "select", { options: ["Always", "IfNotPresent", "Never"] }),
        f("Command", "container", ["command"], "list"),
        f("Arguments", "container", ["args"], "list"),
        f("Working directory", "container", ["workingDir"], "text", { placeholder: "image default" }),
      ],
    },
    ...(script ? [{ title: "Source", hint: "command chooses the interpreter; the source is written to a file and run, and its stdout becomes outputs.result", fields: [f("Script", "container", ["source"], "code", { language: "python" as const })] }] : []),
    {
      title: "Environment",
      fields: [
        f("Variables", "container", ["env"], "kv-list", { kv: ["name", "value"], sub: "Each: name, value or valueFrom (secretKeyRef / configMapKeyRef / fieldRef / resourceFieldRef)" }),
        f("Import from", "container", ["envFrom"], "objects", { item: { configMapRef: { name: "" } }, summary: (i) => (i.configMapRef ? `configMap ${name(i.configMapRef as Record<string, unknown>)}` : `secret ${name((i.secretRef ?? {}) as Record<string, unknown>)}`), sub: "configMapRef / secretRef, optional prefix" }),
      ],
    },
    { title: "Resources", fields: [f("Requests / limits", "container", ["resources"], "resources")] },
    {
      title: "Mounts",
      fields: [f("Volume mounts", "container", ["volumeMounts"], "objects", { item: { name: "work", mountPath: "/work" }, summary: (i) => `${name(i)} → ${String(i.mountPath ?? "")}${i.readOnly ? " (ro)" : ""}`, sub: "Each: name, mountPath, subPath / subPathExpr, readOnly, mountPropagation" })],
    },
    {
      title: "Container security",
      fields: [
        f("Run as user", "container", ["securityContext", "runAsUser"], "number", { placeholder: "image default" }),
        f("Run as non-root", "container", ["securityContext", "runAsNonRoot"], "switch"),
        f("Privileged", "container", ["securityContext", "privileged"], "switch"),
        f("Read-only root filesystem", "container", ["securityContext", "readOnlyRootFilesystem"], "switch"),
        f("Allow privilege escalation", "container", ["securityContext", "allowPrivilegeEscalation"], "switch"),
        f("Capabilities", "container", ["securityContext", "capabilities"], "yaml", { placeholder: "add: [NET_ADMIN]\ndrop: [ALL]" }),
      ],
    },
    {
      title: "More container fields",
      fields: [
        f("Ports", "container", ["ports"], "objects", { item: { name: "http", containerPort: 8080 }, summary: (i) => `${name(i)} ${String(i.containerPort ?? "")}/${String(i.protocol ?? "TCP")}`, sub: "name, containerPort, protocol — used by daemon templates" }),
        f("Liveness probe", "container", ["livenessProbe"], "yaml"),
        f("Readiness probe", "container", ["readinessProbe"], "yaml"),
        f("Startup probe", "container", ["startupProbe"], "yaml"),
        f("Lifecycle hooks", "container", ["lifecycle"], "yaml", { placeholder: "preStop:\n  exec:\n    command: [sh, -c, sleep 5]" }),
        f("Termination message path", "container", ["terminationMessagePath"], "text", { placeholder: "/dev/termination-log" }),
        f("Termination message policy", "container", ["terminationMessagePolicy"], "select", { options: ["File", "FallbackToLogsOnError"] }),
        f("stdin", "container", ["stdin"], "switch"),
        f("tty", "container", ["tty"], "switch"),
      ],
    },
  ];
}

// ---------- kind-specific template config ----------

export function kindSections(kind: NodeKind): SectionDef[] {
  switch (kind) {
    case "container":
      return containerSections(false);
    case "script":
      return containerSections(true);
    case "containerSet":
      return [
        { title: "Containers", fields: [f("Containers", "template", ["containerSet", "containers"], "objects", { item: { name: "step", image: "busybox:1.36", command: ["sh", "-c"], args: ["echo step"] }, summary: (i) => `${name(i)} · ${String(i.image ?? "")}${(i.dependencies as string[] | undefined)?.length ? ` · after ${(i.dependencies as string[]).join(", ")}` : ""}`, sub: "Each: every container field (image, command, args, env, resources, volumeMounts…) plus dependencies" })] },
        { title: "Shared mounts", fields: [f("Volume mounts", "template", ["containerSet", "volumeMounts"], "objects", { item: { name: "workspace", mountPath: "/workspace" }, summary: (i) => `${name(i)} → ${String(i.mountPath ?? "")}`, sub: "Mounted into every container" })] },
        { title: "Container-set retry", hint: "Retries inside the container set, independent of the template's retryStrategy", fields: [f("Retries", "template", ["containerSet", "retryStrategy", "retries"], "text"), f("Duration limit", "template", ["containerSet", "retryStrategy", "duration"], "text", { placeholder: "e.g. 5m" })] },
      ];
    case "resource":
      return [
        {
          title: "Resource operation",
          fields: [
            f("Action", "template", ["resource", "action"], "select", { options: ["get", "create", "apply", "delete", "replace", "patch"] }),
            f("Merge strategy", "template", ["resource", "mergeStrategy"], "select", { options: ["strategic", "merge", "json"] }),
            f("Set owner reference", "template", ["resource", "setOwnerReference"], "switch"),
            f("Extra flags", "template", ["resource", "flags"], "list"),
          ],
        },
        { title: "Manifest", fields: [f("Manifest", "template", ["resource", "manifest"], "code", { language: "yaml" }), f("Manifest from artifact", "template", ["resource", "manifestFrom", "artifact", "name"], "text", { placeholder: "artifact name, instead of manifest" })] },
        { title: "Completion", fields: [f("Success condition", "template", ["resource", "successCondition"], "text", { placeholder: "status.succeeded > 0" }), f("Failure condition", "template", ["resource", "failureCondition"], "text", { placeholder: "status.failed > 2" })] },
      ];
    case "http":
      return [
        {
          title: "Request",
          fields: [
            f("Method", "template", ["http", "method"], "select", { options: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] }),
            f("URL", "template", ["http", "url"], "expression"),
            f("Timeout (seconds)", "template", ["http", "timeoutSeconds"], "number"),
            f("Skip TLS verification", "template", ["http", "insecureSkipVerify"], "switch"),
          ],
        },
        { title: "Headers", fields: [f("Headers", "template", ["http", "headers"], "kv-list", { kv: ["name", "value"], sub: "Each: name, value or valueFrom.secretKeyRef" })] },
        { title: "Body", fields: [f("Body", "template", ["http", "body"], "code", { language: "json" }), f("Body from artifact", "template", ["http", "bodyFrom", "bytes"], "text", { placeholder: "instead of body" })] },
        { title: "Completion", fields: [f("Success condition", "template", ["http", "successCondition"], "text", { placeholder: "response.statusCode >= 200 && response.statusCode < 300" })] },
      ];
    case "data":
      return [
        { title: "Source", fields: [f("Artifact paths", "template", ["data", "source", "artifactPaths"], "yaml", { hint: "name and a storage location (s3 / gcs / oss / azure / hdfs / git / http / artifactory)" })] },
        { title: "Transformation", fields: [f("Steps", "template", ["data", "transformation"], "objects", { item: { expression: "filter(data, {# endsWith \".json\"})" }, summary: (i) => String(i.expression ?? ""), sub: "Each step is one expr expression, applied in order; the result becomes outputs.result" })] },
      ];
    case "plugin":
      return [{ title: "Plugin", hint: "The plugin name is the key; its configuration is defined by the plugin (executor plugins enabled on the controller)", fields: [f("Plugin", "template", ["plugin"], "yaml", { placeholder: "sql:\n  dsn: secret://warehouse\n  query: select 1" })] }];
    case "suspend":
      return [
        { title: "Suspend", fields: [f("Resume automatically after", "template", ["suspend", "duration"], "text", { placeholder: "empty: wait for a manual Resume" })] },
        { title: "Inputs on resume", fields: [f("", "template", [], "note", { hint: "Parameters declared with valueFrom.supplied under Inputs & outputs are asked for when someone resumes the node. Downstream tasks read them as tasks.<name>.outputs.parameters.<param>." })] },
      ];
    case "dag":
      return [
        {
          title: "DAG",
          fields: [
            f("Target", "template", ["dag", "target"], "text", { placeholder: "empty: run every task" }),
            f("Fail fast", "template", ["dag", "failFast"], "switch"),
            f("Tasks", "template", [], "note", { hint: "Double-click the node, or use Open on canvas, to edit the nested DAG on its own canvas." }),
          ],
        },
      ];
    case "steps":
      return [{ title: "Step groups", hint: "Groups run in sequence; the steps of a group run in parallel. Each step has the same fields as a task.", fields: [f("Steps", "template", ["steps"], "yaml", { placeholder: "- - name: a\n    template: x\n  - name: b\n    template: y\n- - name: c\n    template: z" })] }];
    default:
      return [];
  }
}

// ---------- inputs & outputs ----------

export function ioSections(kind: NodeKind): SectionDef[] {
  const result: Record<string, string> = {
    container: "outputs.exitCode: the exit code",
    script: "outputs.result: standard output (up to 256KB) · outputs.exitCode: the exit code",
    containerSet: "outputs.exitCode: the main container's exit code",
    resource: "Output parameters can read the resource with jsonPath / jqFilter",
    http: "outputs.result: the response body",
    data: "outputs.result: the transformed data",
    plugin: "Whatever the plugin returns",
    suspend: "Parameters with valueFrom.supplied are filled in on Resume",
    dag: "Outputs gather task outputs with valueFrom.parameter",
    steps: "Outputs gather step outputs with valueFrom.parameter",
  };
  return [
    { title: "Input parameters", fields: [f("Parameters", "template", ["inputs", "parameters"], "objects", { item: { name: "param" }, summary: (i) => `${name(i)}${i.value !== undefined ? ` = ${String(i.value)}` : i.default !== undefined ? ` (default ${String(i.default)})` : ""}${i.enum ? ` · enum ${(i.enum as string[]).join("/")}` : ""}${i.valueFrom ? " · valueFrom" : ""}`, sub: "Each: name, value / default, enum, description, valueFrom (configMapKeyRef / supplied / expression), globalName" })] },
    { title: "Input artifacts", fields: [f("Artifacts", "template", ["inputs", "artifacts"], "objects", { item: { name: "input", path: "/tmp/input" }, summary: (i) => `${name(i)} → ${String(i.path ?? "")}`, sub: "Each: name, path, from / fromExpression, mode, optional, archive, subPath, recurseMode; sources s3 / gcs / oss / azure / hdfs / git / http / raw / artifactory" })] },
    { title: "Output parameters", fields: [f("Parameters", "template", ["outputs", "parameters"], "objects", { item: { name: "result", valueFrom: { path: "/tmp/result" } }, summary: (i) => `${name(i)} ← ${Object.entries((i.valueFrom ?? {}) as Record<string, unknown>).map(([k, v]) => `${k} ${typeof v === "string" ? v : ""}`).join(", ")}`, sub: "Each: name, valueFrom (path / jsonPath / jqFilter / expression / parameter / supplied / event / default), globalName, description" })] },
    { title: "Output artifacts", fields: [f("Artifacts", "template", ["outputs", "artifacts"], "objects", { item: { name: "output", path: "/tmp/output" }, summary: (i) => `${name(i)} ← ${String(i.path ?? "")}`, sub: "Each: name, path, archive (none / tar / zip), optional, globalName, archiveLogs, storage override, artifactGC" })] },
    { title: "Automatic outputs", fields: [f("", "template", [], "note", { hint: result[kind] ?? "" })] },
  ];
}

// ---------- pod ----------

export function podSections(kind: NodeKind): SectionDef[] | { note: string } {
  if (kind === "http" || kind === "plugin")
    return [
      { title: "Pod", fields: [f("", "template", [], "note", { hint: "Runs in the Argo agent, not its own pod: only metadata applies." })] },
      { title: "Metadata", fields: [f("Labels", "template", ["metadata", "labels"], "kv-map"), f("Annotations", "template", ["metadata", "annotations"], "kv-map")] },
    ];
  if (kind === "suspend" || kind === "dag" || kind === "steps" || kind === "ref" || kind === "unknown") return { note: kind === "ref" ? "Decided by the referenced template; snapshot it to change." : "This kind creates no pod; configure its tasks instead." };
  return [
    { title: "Pod metadata", fields: [f("Labels", "template", ["metadata", "labels"], "kv-map"), f("Annotations", "template", ["metadata", "annotations"], "kv-map")] },
    {
      title: "Scheduling",
      fields: [
        f("Node selector", "template", ["nodeSelector"], "kv-map"),
        f("Tolerations", "template", ["tolerations"], "objects", { item: { key: "", operator: "Exists", effect: "NoSchedule" }, summary: (i) => `${String(i.key ?? "*")} ${String(i.operator ?? "Equal")} ${String(i.value ?? "")} ${String(i.effect ?? "")}`, sub: "Each: key, operator, value, effect, tolerationSeconds" }),
        f("Affinity", "template", ["affinity"], "yaml"),
        f("Scheduler", "template", ["schedulerName"], "text", { placeholder: "default-scheduler" }),
        f("Priority class", "template", ["priorityClassName"], "text"),
      ],
    },
    {
      title: "Identity and security",
      fields: [
        f("ServiceAccount", "template", ["serviceAccountName"], "text", { placeholder: "from the workflow" }),
        f("Mount ServiceAccount token", "template", ["automountServiceAccountToken"], "switch"),
        f("Executor ServiceAccount", "template", ["executor", "serviceAccountName"], "text", { placeholder: "from the workflow" }),
        f("Pod security context", "template", ["securityContext"], "yaml", { placeholder: "runAsNonRoot: true\nfsGroup: 1000" }),
      ],
    },
    {
      title: "Volumes and extra containers",
      fields: [
        f("Volumes", "template", ["volumes"], "objects", { item: { name: "work", emptyDir: {} }, summary: (i) => `${name(i)} · ${Object.keys(i).filter((k) => k !== "name").join(", ")}`, sub: "PVC, configMap, secret, emptyDir, hostPath — any Kubernetes volume" }),
        f("Init containers", "template", ["initContainers"], "objects", { item: { name: "init", image: "busybox:1.36" }, summary: (i) => `${name(i)} · ${String(i.image ?? "")}`, sub: "Every container field plus mirrorVolumeMounts" }),
        f("Sidecars", "template", ["sidecars"], "objects", { item: { name: "sidecar", image: "busybox:1.36" }, summary: (i) => `${name(i)} · ${String(i.image ?? "")}`, sub: "Every container field plus mirrorVolumeMounts; stopped when the main container ends" }),
      ],
    },
    {
      title: "Other",
      fields: [
        f("Host aliases", "template", ["hostAliases"], "objects", { item: { ip: "", hostnames: [] }, summary: (i) => `${String(i.ip ?? "")} ${((i.hostnames as string[]) ?? []).join(" ")}` }),
        f("Pod spec patch", "template", ["podSpecPatch"], "code", { language: "yaml" }),
        f("Archive logs", "template", ["archiveLocation", "archiveLogs"], "switch"),
        f("Archive location", "template", ["archiveLocation"], "yaml", { hint: "Overrides the artifact repository for this template's outputs" }),
      ],
    },
  ];
}

// ---------- policy ----------

export function policySections(kind: NodeKind): SectionDef[] | { note: string } {
  if (kind === "ref") return { note: "Retry, timeouts and caching are decided by the referenced template; snapshot it to change." };
  const out: SectionDef[] = [];
  if (kind !== "suspend")
    out.push({
      title: "Retry · retryStrategy",
      fields: [
        f("Limit", "template", ["retryStrategy", "limit"], "text", { placeholder: "no retries" }),
        f("Retry on", "template", ["retryStrategy", "retryPolicy"], "select", { options: ["Always", "OnFailure", "OnError", "OnTransientError"] }),
        f("Retry when", "template", ["retryStrategy", "expression"], "expression", { placeholder: "lastRetry.exitCode == 137" }),
        f("Backoff duration", "template", ["retryStrategy", "backoff", "duration"], "text", { placeholder: "30s" }),
        f("Backoff factor", "template", ["retryStrategy", "backoff", "factor"], "text", { placeholder: "2" }),
        f("Maximum backoff", "template", ["retryStrategy", "backoff", "maxDuration"], "text", { placeholder: "10m" }),
        f("Backoff cap", "template", ["retryStrategy", "backoff", "cap"], "text", { placeholder: "5m" }),
        f("Avoid the same node", "template", ["retryStrategy", "affinity", "nodeAntiAffinity"], "yaml", { placeholder: "{}" }),
      ],
    });
  out.push({ title: "Timeouts", fields: [f("Timeout", "template", ["timeout"], "text", { placeholder: "1h" }), f("Active deadline", "template", ["activeDeadlineSeconds"], "text", { placeholder: "seconds or an expression" })] });
  out.push({
    title: "Cache · memoize",
    fields: [f("Key", "template", ["memoize", "key"], "expression", { placeholder: "{{inputs.parameters.date}}" }), f("Max age", "template", ["memoize", "maxAge"], "text", { placeholder: "24h" }), f("Cache ConfigMap", "template", ["memoize", "cache", "configMap", "name"], "text", { placeholder: "my-cache" })],
  });
  out.push({
    title: "Concurrency · synchronization",
    fields: [
      f("Mutexes", "template", ["synchronization", "mutexes"], "objects", { item: { name: "lock" }, summary: (i) => `${name(i)}${i.namespace ? ` (${String(i.namespace)})` : ""}${i.database ? " · database" : ""}` }),
      f("Semaphores", "template", ["synchronization", "semaphores"], "objects", { item: { configMapKeyRef: { name: "semaphores", key: "limit" } }, summary: (i) => (i.configMapKeyRef ? `configMap ${String((i.configMapKeyRef as Record<string, unknown>).name)}/${String((i.configMapKeyRef as Record<string, unknown>).key)}` : "database"), sub: "configMapKeyRef (name, key) or database; optionally a namespace" }),
    ],
  });
  const other: FieldDef[] = [];
  if (kind === "dag" || kind === "steps") other.push(f("Parallelism", "template", ["parallelism"], "number", { placeholder: "unlimited" }));
  if (kind === "dag") other.push(f("Fail fast", "template", ["failFast"], "switch"));
  if (kind === "container" || kind === "script" || kind === "containerSet") other.push(f("Daemon", "template", ["daemon"], "switch"));
  other.push(f("Prometheus metrics", "template", ["metrics", "prometheus"], "objects", { item: { name: "duration", help: "", gauge: { value: "{{duration}}" } }, summary: (i) => `${name(i)} · ${["gauge", "counter", "histogram"].find((k) => k in i) ?? ""}`, sub: "name, help, labels, when, and a gauge / counter / histogram" }));
  out.push({ title: "Other", fields: other });
  return out;
}

// ---------- workflow settings ----------

export function workflowTabs(): TabDef[] {
  return [
    {
      id: "wbase",
      label: "Basics",
      sections: [
        {
          title: "Entrypoint and arguments",
          fields: [
            f("Entrypoint", "spec", ["entrypoint"], "text"),
            f("Parameters", "spec", ["arguments", "parameters"], "objects", { item: { name: "param" }, summary: (i) => `${name(i)}${i.value !== undefined ? ` = ${String(i.value)}` : " · required"}${i.enum ? ` · enum ${(i.enum as string[]).join("/")}` : ""}`, sub: "name, value, default, enum, description, valueFrom" }),
            f("Artifacts", "spec", ["arguments", "artifacts"], "objects", { item: { name: "input" }, summary: name }),
          ],
        },
        {
          title: "Execution",
          fields: [
            f("ServiceAccount", "spec", ["serviceAccountName"], "text"),
            f("Active deadline (seconds)", "spec", ["activeDeadlineSeconds"], "number"),
            f("Exit handler", "spec", ["onExit"], "text", { placeholder: "template name" }),
            f("Lifecycle hooks", "spec", ["hooks"], "yaml"),
            f("Priority", "spec", ["priority"], "number"),
          ],
        },
        { title: "Workflow metadata", fields: [f("Labels", "spec", ["workflowMetadata", "labels"], "kv-map"), f("Annotations", "spec", ["workflowMetadata", "annotations"], "kv-map"), f("Labels from expressions", "spec", ["workflowMetadata", "labelsFrom"], "yaml")] },
      ],
    },
    {
      id: "wclean",
      label: "Cleanup",
      sections: [
        { title: "Deletion · ttlStrategy", fields: [f("After completion", "spec", ["ttlStrategy", "secondsAfterCompletion"], "number"), f("After success", "spec", ["ttlStrategy", "secondsAfterSuccess"], "number"), f("After failure", "spec", ["ttlStrategy", "secondsAfterFailure"], "number")] },
        { title: "Pod GC · podGC", fields: [f("Strategy", "spec", ["podGC", "strategy"], "select", { options: ["OnPodCompletion", "OnPodSuccess", "OnWorkflowCompletion", "OnWorkflowSuccess"] }), f("Label selector", "spec", ["podGC", "labelSelector"], "yaml"), f("Delete delay", "spec", ["podGC", "deleteDelayDuration"], "text", { placeholder: "5m" })] },
        {
          title: "Artifacts and logs",
          fields: [
            f("Archive logs", "spec", ["archiveLogs"], "switch"),
            f("Artifact repository", "spec", ["artifactRepositoryRef"], "yaml", { placeholder: "configMap: artifact-repositories\nkey: default" }),
            f("Artifact GC strategy", "spec", ["artifactGC", "strategy"], "select", { options: ["Never", "OnWorkflowCompletion", "OnWorkflowDeletion"] }),
            f("Artifact GC ServiceAccount", "spec", ["artifactGC", "serviceAccountName"], "text"),
            f("Artifact GC pod metadata", "spec", ["artifactGC", "podMetadata"], "yaml"),
          ],
        },
      ],
    },
    {
      id: "wpod",
      label: "Pod defaults",
      sections: [
        { title: "Pod metadata", fields: [f("Labels", "spec", ["podMetadata", "labels"], "kv-map"), f("Annotations", "spec", ["podMetadata", "annotations"], "kv-map")] },
        {
          title: "Scheduling",
          fields: [
            f("Node selector", "spec", ["nodeSelector"], "kv-map"),
            f("Tolerations", "spec", ["tolerations"], "objects", { item: { key: "", operator: "Exists" }, summary: (i) => `${String(i.key ?? "*")} ${String(i.operator ?? "")} ${String(i.effect ?? "")}` }),
            f("Affinity", "spec", ["affinity"], "yaml"),
            f("Scheduler", "spec", ["schedulerName"], "text"),
            f("Pod priority class", "spec", ["podPriorityClassName"], "text"),
            f("Pod disruption budget", "spec", ["podDisruptionBudget"], "yaml", { placeholder: "minAvailable: 1" }),
          ],
        },
        {
          title: "Identity and security",
          fields: [
            f("Image pull secrets", "spec", ["imagePullSecrets"], "objects", { item: { name: "registry-cred" }, summary: name }),
            f("Executor ServiceAccount", "spec", ["executor", "serviceAccountName"], "text"),
            f("Mount ServiceAccount token", "spec", ["automountServiceAccountToken"], "switch"),
            f("Pod security context", "spec", ["securityContext"], "yaml"),
          ],
        },
        { title: "Network", fields: [f("Host network", "spec", ["hostNetwork"], "switch"), f("DNS policy", "spec", ["dnsPolicy"], "select", { options: ["ClusterFirst", "ClusterFirstWithHostNet", "Default", "None"] }), f("DNS config", "spec", ["dnsConfig"], "yaml"), f("Host aliases", "spec", ["hostAliases"], "yaml")] },
        {
          title: "Volumes",
          fields: [
            f("Volumes", "spec", ["volumes"], "objects", { item: { name: "work", emptyDir: {} }, summary: (i) => `${name(i)} · ${Object.keys(i).filter((k) => k !== "name").join(", ")}` }),
            f("Volume claim templates", "spec", ["volumeClaimTemplates"], "yaml", { hint: "A PVC per run" }),
            f("Volume claim GC", "spec", ["volumeClaimGC", "strategy"], "select", { options: ["OnWorkflowCompletion", "OnWorkflowSuccess"] }),
          ],
        },
        { title: "Template defaults", fields: [f("templateDefaults", "spec", ["templateDefaults"], "yaml", { placeholder: "timeout: 2h\nretryStrategy:\n  limit: 1" }), f("Pod spec patch", "spec", ["podSpecPatch"], "code", { language: "yaml" })] },
      ],
    },
    {
      id: "wpolicy",
      label: "Concurrency & metrics",
      sections: [
        { title: "Concurrency", fields: [f("Parallelism", "spec", ["parallelism"], "number"), f("Synchronization", "spec", ["synchronization"], "yaml", { placeholder: "mutexes:\n  - name: etl" })] },
        { title: "Workflow retry", fields: [f("Retry strategy", "spec", ["retryStrategy"], "yaml")] },
        { title: "Metrics", fields: [f("Prometheus metrics", "spec", ["metrics", "prometheus"], "yaml")] },
      ],
    },
  ];
}

// ---------- schema coverage ----------

type SchemaDef = { properties?: Record<string, { description?: string }> };
const defs = (argoSchema as { definitions: Record<string, SchemaDef> }).definitions;

/**
 * Properties of an Argo type that no hand-written field covers, as "Other fields" (YAML controls).
 * `covered` are the first path segments the hand-written fields use at that base.
 */
export function uncovered(definition: string, base: Base, covered: Set<string>, exclude: string[] = []): FieldDef[] {
  const props = defs[definition]?.properties ?? {};
  return Object.keys(props)
    .filter((k) => !covered.has(k) && !exclude.includes(k))
    .sort()
    .map((k) => f(k, base, [k], "yaml", { hint: props[k].description?.split(". ")[0] }));
}

export const TEMPLATE_DEF = "io.argoproj.workflow.v1alpha1.Template";
export const TASK_DEF = "io.argoproj.workflow.v1alpha1.DAGTask";
export const STEP_DEF = "io.argoproj.workflow.v1alpha1.WorkflowStep";
export const CONTAINER_DEF = "io.k8s.api.core.v1.Container";
export const SCRIPT_DEF = "io.argoproj.workflow.v1alpha1.ScriptTemplate";
export const SPEC_DEF = "io.argoproj.workflow.v1alpha1.WorkflowSpec";

/** Template fields that are another kind's body, never "other fields" of this one. */
export const KIND_KEYS = ["container", "script", "containerSet", "resource", "http", "data", "plugin", "suspend", "dag", "steps"];
