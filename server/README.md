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
  authz/              Cedar engine and the built-in role policies (policies/roles.cedar)
  oidc/               OIDC discovery, session tokens, auth middleware
  server/             HTTP server, middleware chain, artifact routes
pkg/argo/             Argo servers wired to client-go; artifact reader; stream adapters
```

## Running

```sh
make migrate          # create or upgrade the tables
make api              # regenerate from proto after changing api/v1
make wire             # regenerate DI after changing providers
go run ./cmd server   # start on :4100
```

PostgreSQL stores grants, the user directory, audit events and template revision history.
Workflows, templates and cron workflows always come from Kubernetes.

### Configuration

Configuration is layered the kratos-scaffold way, later layers winning:

1. `configs/default/config.yaml` — the defaults, compiled into the binary and documented inline.
2. `configs/local/` — your own overrides, Git-ignored. Start from `configs/local.example.yaml`.
3. `--config <file or dir>` — an explicit overlay (the Helm chart mounts one; `configs/dev-archive`
   switches to the local archive setup).
4. `ARGONAUT_*` environment variables, which fill the `${VAR}` placeholders: `${DATABASE_URL}`,
   `${JWT_SECRET}` and `${SSO_CLIENT_SECRET}`.

Three settings deserve attention:

- **`kube.context`** — pin it. Without a pinned context the server follows whatever kubeconfig context
  happens to be current, and can silently attach to a different cluster. The resolved context is
  logged at startup; check it.
- **`argo.controller_configmap`** — the artifact repository, the persistence database (node status
  offload) and the configured links are all read from this ConfigMap at runtime, exactly as
  argo-server does. Artifact credentials are never configured here. It is parsed tolerantly, so a
  controller newer than the pinned Argo library does not stop the server from starting.
- **`authz.super_admins`** — optional recovery administrators identified by OIDC subject.

With `sso.enabled: false`, every request uses the `developer` identity and can read and modify
workflows, templates, and cron workflows without grants or Cedar policies. Set
`authz.dev_subject` to use a different identity. Managing grants, users, or policies still
requires the corresponding permissions. The server listens on `127.0.0.1:4100` by default
in this mode. An explicit `server.http.addr` overrides the default.

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

### Local users and first-run setup

Configure OIDC sign-in before starting Argonaut. On a fresh database, set `ARGONAUT_SETUP_TOKEN`
to a random secret of at least 32 bytes, run the migrations and open the login page. The setup
wizard reserves the global `admin` role for the email entered. Sign in through Logto using an
account with that verified email to activate the role. The wizard closes after the reservation
and is skipped when an administrator is already configured. Remove the token after setup.

Global grant administrators can add local users by email under **Permissions → Users**. The
directory shows them immediately so grants can be prepared before their first sign-in. The first
verified sign-in for that address binds the profile and grants to the OIDC subject.

## Authorization

Successful OIDC sign-ins update the local user directory with the account's subject, name, email
and most recent sign-in time. Grant administrators can search by name or email after choosing a
scope. For someone who has yet to sign in, create a pending grant by email. The first sign-in with
that verified email binds the grant to the account's OIDC subject.

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
