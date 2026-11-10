-- +goose Up
ALTER TABLE authz_meta ADD COLUMN setup_completed BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE authz_meta SET setup_completed = TRUE
WHERE id = 1 AND EXISTS (
    SELECT 1 FROM grants WHERE subject_type = 'user' AND resource_type = 'global' AND role = 'admin'
);
ALTER TABLE users ALTER COLUMN last_login_at DROP NOT NULL;

-- +goose Down
UPDATE users SET last_login_at = now() WHERE last_login_at IS NULL;
ALTER TABLE users ALTER COLUMN last_login_at SET NOT NULL;
ALTER TABLE authz_meta DROP COLUMN setup_completed;
