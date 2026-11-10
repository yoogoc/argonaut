package data

import (
	"context"

	"argonaut/internal/authz"
	"argonaut/internal/biz"
	"argonaut/pkg/id"

	"github.com/go-kratos/kratos/v3/errors"
	"github.com/jackc/pgx/v5"
)

const setupCompleteSQL = `SELECT setup_completed OR EXISTS (
	SELECT 1 FROM grants WHERE subject_type = 'user' AND resource_type = 'global' AND role = 'admin'
) FROM authz_meta WHERE id = 1`

func (r *authzRepo) SetupComplete(ctx context.Context) (bool, error) {
	var complete bool
	err := r.data.pool.QueryRow(ctx, setupCompleteSQL).Scan(&complete)
	return complete, err
}

func (r *authzRepo) BootstrapAdmin(ctx context.Context, account biz.NewAccount) (int64, error) {
	audit := biz.AuditEvent{
		Actor: "setup", Action: string(authz.AuthzGrant), ResourceType: authz.ResourceGlobal,
		Result: biz.AuditAllowed, Reason: "first administrator reserved for " + account.Email,
	}
	return r.change(ctx, audit, func(tx pgx.Tx, rev int64) error {
		var complete bool
		if err := tx.QueryRow(ctx, setupCompleteSQL).Scan(&complete); err != nil {
			return err
		}
		if complete {
			return errors.Conflict("setup_complete", "the platform already has an administrator")
		}
		if _, err := r.insertPendingUser(ctx, tx, account); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO grants
			(id, subject_type, subject, resource_type, name, role, created_by, revision, subject_issuer)
			VALUES ($1, 'email', $2, 'global', '*', 'admin', 'setup', $3, $4)
			ON CONFLICT (subject_type, subject, resource_type, namespace, name, role, subject_issuer) DO NOTHING`,
			id.Generate(), account.Email, rev, r.issuer); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE authz_meta SET setup_completed = TRUE WHERE id = 1`)
		return err
	})
}

func (r *authzRepo) CreateLocalUser(ctx context.Context, account biz.NewAccount, actor string) error {
	return pgx.BeginFunc(ctx, r.data.pool, func(tx pgx.Tx) error {
		if err := lockAuthzRevision(ctx, tx); err != nil {
			return err
		}
		inserted, err := r.insertPendingUser(ctx, tx, account)
		if err != nil {
			return err
		}
		if !inserted {
			return errors.Conflict("user_exists", "a user with this email already exists")
		}
		return insertAudit(ctx, tx, biz.AuditEvent{
			Actor: actor, Action: "authz:create-user", ResourceType: "user", Name: account.Email,
			Result: biz.AuditAllowed, Reason: "created local user",
		})
	})
}

func (r *authzRepo) insertPendingUser(ctx context.Context, tx pgx.Tx, account biz.NewAccount) (bool, error) {
	// A verified identity or an existing reservation already represents this email. An
	// unverified address from a sign-in must not block provisioning the actual address owner.
	tag, err := tx.Exec(ctx, `INSERT INTO users (issuer, subject, name, email, email_verified, last_login_at)
		SELECT $1, NULL, $2, $3, FALSE, NULL WHERE NOT EXISTS (
			SELECT 1 FROM users WHERE issuer = $1 AND lower(email) = $3
			AND (subject IS NULL OR email_verified OR last_login_at IS NULL)
		)`, r.issuer, account.Name, account.Email)
	return tag.RowsAffected() > 0, err
}
