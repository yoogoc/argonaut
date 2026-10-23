-- +goose Up
-- Template history and audit record which cluster they belong to when an instance can be switched
-- between clusters (docs/multi-cluster.md). Empty means the single configured cluster, so rows written
-- before this migration keep their meaning.
-- +goose StatementBegin
ALTER TABLE template_revisions ADD COLUMN cluster VARCHAR(63) NOT NULL DEFAULT '';
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE template_revisions DROP CONSTRAINT template_revisions_scope_namespace_name_seq_key;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE template_revisions ADD CONSTRAINT template_revisions_cluster_scope_namespace_name_seq_key UNIQUE (cluster, scope, namespace, name, seq);
-- +goose StatementEnd
-- +goose StatementBegin
DROP INDEX template_revisions_rv;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX template_revisions_rv ON template_revisions (cluster, scope, namespace, name, resource_version);
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE audit_events ADD COLUMN cluster VARCHAR(63) NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE audit_events DROP COLUMN cluster;
-- +goose StatementEnd
-- +goose StatementBegin
DROP INDEX template_revisions_rv;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE template_revisions DROP CONSTRAINT template_revisions_cluster_scope_namespace_name_seq_key;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE template_revisions DROP COLUMN cluster;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE template_revisions ADD CONSTRAINT template_revisions_scope_namespace_name_seq_key UNIQUE (scope, namespace, name, seq);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX template_revisions_rv ON template_revisions (scope, namespace, name, resource_version);
-- +goose StatementEnd
