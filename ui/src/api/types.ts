// The API's types. Workflow-shaped payloads are Argo's own CRD types passed through unchanged, so
// they are typed loosely here: modelling every Argo field would duplicate the CRD and go stale, and
// the UI reads them the same way Argo's own console does. argonaut's own DTOs, at the end, are
// derived from the types generated from server/api/v1/*.proto.

import type * as api from "./gen/api.gen";

export interface ObjectMeta {
  name: string;
  generateName?: string;
  namespace: string;
  uid?: string;
  resourceVersion?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export type NodePhase =
  | "Pending"
  | "Running"
  | "Succeeded"
  | "Failed"
  | "Error"
  | "Omitted"
  | "Skipped";

export interface Parameter {
  name: string;
  value?: string;
  default?: string;
  enum?: string[];
  description?: string;
}

/** A stored input or output. Only the backends Argo can report are modelled; all are optional. */
export interface Artifact {
  name: string;
  /** Where the artifact was mounted inside the container. */
  path?: string;
  optional?: boolean;
  /** Argo wraps directories in an archive unless the template opts out. */
  archive?: { none?: object; tar?: { compressionLevel?: number }; zip?: object };
  s3?: { bucket?: string; key?: string; endpoint?: string };
  gcs?: { bucket?: string; key?: string };
  oss?: { bucket?: string; key?: string; endpoint?: string };
  azure?: { container?: string; blob?: string; endpoint?: string };
  http?: { url?: string };
  git?: { repo?: string; revision?: string };
  raw?: { data?: string };
}

export interface Inputs {
  parameters?: Parameter[];
  artifacts?: Artifact[];
}

export interface Outputs {
  parameters?: Parameter[];
  artifacts?: Artifact[];
  exitCode?: string;
  result?: string;
}

export interface NodeStatus {
  id: string;
  name: string;
  displayName: string;
  type: string;
  /** Which resource the node's template came from; needed to resolve it (see lib/template.ts). */
  templateScope?: string;
  phase?: NodePhase;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: string;
  templateName?: string;
  templateRef?: { name: string; template: string };
  boundaryID?: string;
  children?: string[];
  outboundNodes?: string[];
  inputs?: Inputs;
  outputs?: Outputs;
  hostNodeName?: string;
  podIP?: string;
  estimatedDuration?: number;
  resourcesDuration?: Record<string, number>;
  /**
   * Present when the node's template is memoized. `hit` means the step never ran and these outputs
   * came from the cache, which is otherwise indistinguishable from a very fast success.
   */
  memoizationStatus?: { hit?: boolean; key?: string; cacheName?: string };
}

/** A container Argo runs, plus the extra fields a `script` template adds. */
export interface ContainerSpec {
  name?: string;
  image?: string;
  command?: string[];
  args?: string[];
  workingDir?: string;
  /** Present on script templates: the program Argo writes into the container and runs. */
  source?: string;
  env?: { name: string; value?: string; valueFrom?: unknown }[];
  resources?: { limits?: Record<string, string>; requests?: Record<string, string> };
  /** Set by templateContainers for sidecars, so the panel can label them. */
  sidecar?: boolean;
}

/** An `http` template: Argo performs the request itself, with no pod. */
export interface HttpSpec {
  method?: string;
  url?: string;
  headers?: { name: string; value?: string; valueFrom?: unknown }[];
  body?: string;
  timeoutSeconds?: number;
  successCondition?: string;
  insecureSkipVerify?: boolean;
}

/** One entry of a workflow's template list, or a stored copy of a referenced template. */
export interface Template {
  name?: string;
  inputs?: Inputs;
  outputs?: Outputs;
  /** Set when this template only points at another one; resolution follows these. */
  template?: string;
  templateRef?: { name: string; template: string; clusterScope?: boolean };
  container?: ContainerSpec;
  script?: ContainerSpec;
  containerSet?: { containers: ContainerSpec[] };
  sidecars?: ContainerSpec[];
  http?: HttpSpec;
  resource?: { action?: string; manifest?: string; successCondition?: string; failureCondition?: string };
  data?: { source?: unknown; transformation?: unknown[] };
  dag?: { tasks: { name: string; template?: string; dependencies?: string[] }[] };
  steps?: { name: string; template?: string }[][];
  suspend?: { duration?: string };
  /** Caches this template's outputs under `key`, so a later run with the same key skips execution. */
  memoize?: {
    key?: string;
    maxAge?: string;
    cache?: { configMap?: { name?: string; key?: string } };
  };
  retryStrategy?: unknown;
  activeDeadlineSeconds?: unknown;
  serviceAccountName?: string;
  nodeSelector?: Record<string, string>;
  [key: string]: unknown;
}

export interface WorkflowStatus {
  phase?: NodePhase;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: string;
  nodes?: Record<string, NodeStatus>;
  conditions?: { type: string; status: string; message?: string }[];
  resourcesDuration?: Record<string, number>;
  estimatedDuration?: number;
  outputs?: Outputs;
  /** Copies of referenced templates, keyed by a scope-qualified name. */
  storedTemplates?: Record<string, Template>;
  /** The spec of the WorkflowTemplate this run came from, when it was submitted from one. */
  storedWorkflowTemplateSpec?: { templates?: Template[]; entrypoint?: string; arguments?: { parameters?: Parameter[] } };
  artifactRepositoryRef?: unknown;
}

export interface WorkflowSpec {
  entrypoint?: string;
  arguments?: { parameters?: Parameter[]; artifacts?: Artifact[] };
  templates?: Template[];
  workflowTemplateRef?: { name: string; clusterScope?: boolean };
  suspend?: boolean;
  serviceAccountName?: string;
  [key: string]: unknown;
}

export interface WorkflowTemplateSpecTemplate {
  name: string;
  inputs?: Inputs;
  outputs?: Outputs;
  dag?: { tasks: { name: string; template?: string; dependencies?: string[] }[] };
  steps?: { name: string; template?: string }[][];
  container?: { image?: string; command?: string[]; args?: string[] };
  script?: { image?: string; source?: string };
  suspend?: unknown;
  [key: string]: unknown;
}

export interface Workflow {
  metadata: ObjectMeta;
  spec: WorkflowSpec;
  status?: WorkflowStatus;
}

export interface WorkflowTemplate {
  metadata: ObjectMeta;
  spec: WorkflowSpec;
}

export interface CronWorkflowSpec {
  schedules?: string[];
  /** Argo before 3.6 used a single `schedule`; both are accepted so older objects still render. */
  schedule?: string;
  timezone?: string;
  suspend?: boolean;
  concurrencyPolicy?: string;
  startingDeadlineSeconds?: number;
  successfulJobsHistoryLimit?: number;
  failedJobsHistoryLimit?: number;
  workflowSpec: WorkflowSpec;
  [key: string]: unknown;
}

export interface CronWorkflowStatus {
  active?: { name: string; namespace: string }[];
  lastScheduledTime?: string;
  conditions?: { type: string; status: string; message?: string }[];
}

export interface CronWorkflow {
  metadata: ObjectMeta;
  spec: CronWorkflowSpec;
  status?: CronWorkflowStatus;
}

export interface ListMeta {
  resourceVersion?: string;
  continue?: string | null;
  remainingItemCount?: number | null;
}

export interface List<T> {
  metadata?: ListMeta;
  items: T[] | null;
}

// ---- argonaut's own DTOs ----
// The shapes come from the generated proto types (api/gen/api.gen.ts, `pnpm gen:api`), where every
// field is optional because the server omits zero values. `Present` marks the fields the server always
// fills (identifiers, timestamps), and string unions narrow what proto can only call a string.

/** T with the keys K made required: the server always sets them, so they are never omitted. */
type Present<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;

export type WorkflowWatchEvent = Present<api.WorkflowWatchEvent, "workflowJson"> & {
  type: "ADDED" | "MODIFIED" | "DELETED";
};

export type WorkflowEvent = Present<api.WorkflowEvent, "type" | "reason" | "objectName" | "objectKind">;

export type LogEntry = api.WorkflowLogEntry;

export type UserInfo = Present<api.Oauth2UserInfoReply, "issuer" | "subject">;

export type Info = api.GetInfoReply;

export type Role = "viewer" | "operator" | "editor" | "admin";

export type GrantResourceType = "global" | "namespace" | "template" | "cluster_template";

export type Grant = Present<api.Grant, "id" | "subject" | "createdBy" | "createdAt" | "revision"> & {
  role: Role;
  resourceType: GrantResourceType;
};

export type RoleInfo = Present<api.Role, "actions" | "description"> & { name: Role };

export type MyPermissions = Present<Omit<api.MyPermissionsReply, "grants">, "subject"> & { grants?: Grant[] };

/** What a permission question is asked about (see DESIGN §4.4 for how runs map onto these). */
export type ResourceRef = api.ActionsRequest;

export type AuditEvent = Present<api.AuditEvent, "id" | "at" | "actor" | "action" | "resourceType"> & {
  result: "allowed" | "denied" | "recorded";
};

export type AuthzStatus = Omit<api.AuthzStatusReply, "replicas" | "lastChange"> & {
  replicas?: Present<api.Replica, "id" | "seenAt">[];
  lastChange?: AuditEvent;
};

export type Policy = Present<api.Policy, "id" | "name" | "body" | "createdAt">;

export type TemplateRevision = Present<api.TemplateRevision, "id" | "seq" | "resourceVersion" | "createdAt">;

export type Component = api.Component;
