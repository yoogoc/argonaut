-- +goose Up
-- +goose StatementBegin
CREATE TABLE grants (
    id            BIGINT       NOT NULL PRIMARY KEY,
    subject_type  VARCHAR(32)  NOT NULL DEFAULT 'user',
    subject       VARCHAR(255) NOT NULL,
    resource_type VARCHAR(32)  NOT NULL DEFAULT 'template',
    namespace     VARCHAR(255) NOT NULL DEFAULT '',
    name          VARCHAR(255) NOT NULL DEFAULT '*',
    role          VARCHAR(32)  NOT NULL,
    created_by    VARCHAR(255) NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX grant_subject ON grants (subject);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX grant_namespace_name ON grants (namespace, name);
-- +goose StatementEnd

-- Re-granting the same role on the same scope must update nothing rather than pile up rows.
-- +goose StatementBegin
CREATE UNIQUE INDEX grant_subject_type_subject_resource_type_namespace_name_role
    ON grants (subject_type, subject, resource_type, namespace, name, role);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE grants;
-- +goose StatementEnd
