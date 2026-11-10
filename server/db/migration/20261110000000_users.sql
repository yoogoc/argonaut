-- +goose Up
CREATE TABLE users (
    issuer         TEXT NOT NULL,
    subject        VARCHAR(255) NOT NULL,
    name           TEXT NOT NULL,
    email          TEXT NOT NULL,
    email_verified BOOLEAN NOT NULL,
    last_login_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (issuer, subject)
);

-- Only unclaimed email grants are issuer-scoped. Bound grants use the existing subject model.
ALTER TABLE grants ADD COLUMN subject_issuer TEXT NOT NULL DEFAULT '';
DROP INDEX grant_subject_type_subject_resource_type_namespace_name_role;
CREATE UNIQUE INDEX grant_subject_scope_role ON grants
    (subject_type, subject, resource_type, namespace, name, role, subject_issuer);

-- +goose Down
DELETE FROM grants WHERE subject_type = 'email';
DROP INDEX grant_subject_scope_role;
ALTER TABLE grants DROP COLUMN subject_issuer;
CREATE UNIQUE INDEX grant_subject_type_subject_resource_type_namespace_name_role
    ON grants (subject_type, subject, resource_type, namespace, name, role);
DROP TABLE users;
