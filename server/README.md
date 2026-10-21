# argonaut-server

An Argo Workflows console backend: OIDC login, OPA authorization, and read/write access to
Workflows, WorkflowTemplates and CronWorkflows.

**It never talks to argo-server.** Argo's own server packages (`server/workflow`,
`server/workflowtemplate`, `server/cronworkflow`) run in-process against the Kubernetes API, so
retry/resubmit semantics, node-status hydration, log streaming and artifact resolution are Argo's
real implementations rather than reimplementations. See `pkg/argo/client.go`, which mirrors
`server/apiserver/argoserver.go`.

## Layout

```
api/v1/*.proto        the contract, and the source of truth for argonaut-ui's types
internal/
  service/            HTTP handlers; proto <-> biz; SSE streams
  biz/                use cases: authorization decisions, list filtering, action orchestration
  data/               Ent repository for the grants table
  authz/              OPA engine + the rego policy (policy.rego)
  oidc/               OIDC discovery, session tokens, auth middleware
  server/             HTTP server, middleware chain, artifact routes
pkg/argo/             Argo servers wired to client-go; artifact reader; stream adapters
```

## Running

```sh
make migrate          # create the grants table
make api              # regenerate from proto after changing api/v1
make wire             # regenerate DI after changing providers
go run ./cmd server   # start on :4000
```

The only persistent state is the `grants` table. Workflows, templates and cron workflows always come
from Kubernetes, so the database can be rebuilt without losing anything but permissions.

### Configuration

`configs/config.yaml` is documented inline. Three settings deserve attention:

- **`kube.context`** — pin it. Without a pinned context the server follows whatever kubeconfig context
  happens to be current, and can silently attach to a different cluster. The resolved context is
  logged at startup; check it.
- **`argo.controller_configmap`** — the artifact repository, the persistence database (node status
  offload) and the configured links are all read from this ConfigMap at runtime, exactly as
  argo-server does. Artifact credentials are never configured here. It is parsed tolerantly, so a
  controller newer than the pinned Argo library does not stop the server from starting.
- **`authz.super_admins`** — bootstrap at least one OIDC subject, or nobody can issue the first grant.

For local development without an identity provider, set `sso.enabled: false` and
`authz.dev_subject: <subject>`; every request is then treated as that user. The server logs a warning
each time it starts in that mode.

### Kubeconfig contexts that use a credential plugin

`Unauthorized` at startup means Kubernetes rejected the credentials, not that RBAC denied access.
Contexts for managed clusters usually authenticate through an exec plugin — an EKS context runs
`aws eks get-token` — and the plugin reads its credentials from the **server process's own
environment**. Starting the server from a shell without `AWS_PROFILE` (or the corresponding access
keys) therefore fails even though `kubectl` works in your terminal:

```sh
AWS_PROFILE=your-profile go run ./cmd server
```

This only affects running locally against such a context. A deployed server uses its in-cluster
ServiceAccount and needs no plugin.

## Authorization

Permissions are granted on WorkflowTemplates. A workflow or cron workflow inherits the permissions of
the template it derives from (via `spec.workflowTemplateRef`, falling back to the
`workflows.argoproj.io/workflow-template` label); anything with no template lineage is covered only by
a namespace-wide grant. Roles are fixed — viewer, operator, editor, admin — and `admin` includes
`authz:grant`, which makes "who may authorize whom" part of the same policy as everything else. A
grant can never exceed what its issuer holds.

Decisions are made by OPA evaluating `internal/authz/policy.rego`; `internal/authz/engine_test.go`
covers the cases that matter, including that a single-template grant must not reach workflows with no
template lineage.

## Kubernetes RBAC

The ServiceAccount needs: read/write on `workflows`, `workfloweventbindings`, `workflowtemplates` and
`cronworkflows`; read on `pods` and `pods/log`; read on `events`; and read on the `configmaps` and
`secrets` holding the controller config and artifact repository credentials.
