-- argonaut's own tables beyond grants (DESIGN §4.3, §3.6). Workflow content still lives only in
-- Kubernetes; these record who may do what, what they did, and how templates changed.

-- +goose Up

-- Grants now name their scope explicitly ("namespace" instead of a template grant on "*") and record
-- the authorization revision that wrote them.
-- +goose StatementBegin
UPDATE grants SET resource_type = 'namespace' WHERE resource_type = 'template' AND name = '*';
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE grants ADD COLUMN revision BIGINT NOT NULL DEFAULT 0;
-- +goose StatementEnd

-- One row, one number: every change to grants or policies increments it in the same transaction, and
-- every authorization decision is taken against a snapshot at least this new.
-- +goose StatementBegin
CREATE TABLE authz_meta (
    id       SMALLINT PRIMARY KEY CHECK (id = 1),
    revision BIGINT   NOT NULL
);
-- +goose StatementEnd
-- +goose StatementBegin
INSERT INTO authz_meta (id, revision) VALUES (1, 1);
-- +goose StatementEnd

-- Custom Cedar policies (forbid / permit) layered on the built-in role policies.
-- +goose StatementBegin
CREATE TABLE authz_policies (
    id          BIGINT       NOT NULL PRIMARY KEY,
    name        VARCHAR(128) NOT NULL UNIQUE,
    description TEXT         NOT NULL DEFAULT '',
    body        TEXT         NOT NULL,
    enabled     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_by  VARCHAR(255) NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    revision    BIGINT       NOT NULL DEFAULT 0
);
-- +goose StatementEnd

-- Which revision each replica has loaded, so the UI can show that a change has reached every replica.
-- +goose StatementBegin
CREATE TABLE authz_replicas (
    id       VARCHAR(255) PRIMARY KEY,
    revision BIGINT       NOT NULL,
    seen_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- +goose StatementEnd

-- Every write argonaut performs and every request it refuses. Kubernetes only ever sees the platform
-- ServiceAccount, so this is the record of who did what.
-- +goose StatementBegin
CREATE TABLE audit_events (
    id            BIGINT       NOT NULL PRIMARY KEY,
    at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    actor         VARCHAR(255) NOT NULL,
    action        VARCHAR(64)  NOT NULL,
    resource_type VARCHAR(32)  NOT NULL DEFAULT '',
    namespace     VARCHAR(255) NOT NULL DEFAULT '',
    name          VARCHAR(255) NOT NULL DEFAULT '',
    result        VARCHAR(16)  NOT NULL,
    reason        TEXT         NOT NULL DEFAULT '',
    detail        JSONB,
    revision      BIGINT       NOT NULL DEFAULT 0
);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX audit_events_at ON audit_events (at DESC);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX audit_events_actor ON audit_events (actor, at DESC);
-- +goose StatementEnd

-- Template history (DESIGN §3.6). scope is "namespace" or "cluster"; namespace is empty for the latter.
-- +goose StatementBegin
CREATE TABLE template_revisions (
    id               BIGINT       NOT NULL PRIMARY KEY,
    scope            VARCHAR(16)  NOT NULL,
    namespace        VARCHAR(255) NOT NULL DEFAULT '',
    name             VARCHAR(255) NOT NULL,
    seq              INT          NOT NULL,
    uid              VARCHAR(64)  NOT NULL DEFAULT '',
    resource_version VARCHAR(64)  NOT NULL DEFAULT '',
    manifest         JSONB        NOT NULL,
    author           VARCHAR(255) NOT NULL DEFAULT '',
    external         BOOLEAN      NOT NULL DEFAULT FALSE,
    message          TEXT         NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (scope, namespace, name, seq)
);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX template_revisions_rv ON template_revisions (scope, namespace, name, resource_version);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE template_revisions;
-- +goose StatementEnd
-- +goose StatementBegin
DROP TABLE audit_events;
-- +goose StatementEnd
-- +goose StatementBegin
DROP TABLE authz_replicas;
-- +goose StatementEnd
-- +goose StatementBegin
DROP TABLE authz_policies;
-- +goose StatementEnd
-- +goose StatementBegin
DROP TABLE authz_meta;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE grants DROP COLUMN revision;
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE grants SET resource_type = 'template' WHERE resource_type = 'namespace';
-- +goose StatementEnd
