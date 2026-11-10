-- +goose Up
ALTER TABLE users DROP CONSTRAINT users_pkey;
ALTER TABLE users ADD COLUMN id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY;
ALTER TABLE users ALTER COLUMN subject DROP NOT NULL;
ALTER TABLE users ADD UNIQUE (issuer, subject);
CREATE UNIQUE INDEX users_pending_email ON users (issuer, lower(email)) WHERE subject IS NULL;

-- +goose Down
DELETE FROM users WHERE subject IS NULL;
DROP INDEX users_pending_email;
ALTER TABLE users DROP CONSTRAINT users_issuer_subject_key;
ALTER TABLE users DROP COLUMN id;
ALTER TABLE users ADD PRIMARY KEY (issuer, subject);
