package data

import (
	"context"

	"argonaut/internal/authz"
	"argonaut/internal/biz"

	"github.com/jackc/pgx/v5"
)

func (r *authzRepo) FindUsers(ctx context.Context, query string, limit, offset int) ([]biz.User, error) {
	rows, err := r.data.pool.Query(ctx, `SELECT COALESCE(subject, ''), name, email, email_verified, last_login_at FROM users
		WHERE issuer = $1 AND ($2 = '' OR strpos(lower(name), lower($2)) > 0
			OR strpos(lower(email), lower($2)) > 0 OR strpos(lower(subject), lower($2)) > 0)
		ORDER BY ($2 <> '' AND lower(email) = lower($2)) DESC, last_login_at DESC NULLS LAST, id
		LIMIT $3 OFFSET $4`, r.issuer, query, limit, offset)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (biz.User, error) {
		var user biz.User
		err := row.Scan(&user.Subject, &user.Name, &user.Email, &user.EmailVerified, &user.LastLoginAt)
		return user, err
	})
}

func (r *authzRepo) upsertUser(ctx context.Context, db execer, user biz.User) error {
	_, err := db.Exec(ctx, `INSERT INTO users (issuer, subject, name, email, email_verified)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (issuer, subject) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email,
			email_verified = EXCLUDED.email_verified, last_login_at = now()`,
		r.issuer, user.Subject, user.Name, user.Email, user.EmailVerified)
	return err
}

func (r *authzRepo) RecordLogin(ctx context.Context, user biz.User) (int64, error) {
	email := biz.NormalizeEmail(user.Email)
	if !user.EmailVerified || email == "" {
		return 0, r.upsertUser(ctx, r.data.pool, user)
	}
	var rev int64
	err := pgx.BeginFunc(ctx, r.data.pool, func(tx pgx.Tx) error {
		// Serialize binding with setup, pre-authorization and local user creation.
		if err := lockAuthzRevision(ctx, tx); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM users WHERE issuer = $1 AND subject IS NULL AND lower(email) = $2`, r.issuer, email); err != nil {
			return err
		}
		if err := r.upsertUser(ctx, tx, user); err != nil {
			return err
		}
		var pending bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM grants WHERE subject_type = 'email' AND subject = $1 AND subject_issuer = $2
		)`, email, r.issuer).Scan(&pending); err != nil || !pending {
			return err
		}
		audit := biz.AuditEvent{
			Actor: user.Subject, Action: string(authz.AuthzGrant), ResourceType: authz.ResourceGlobal,
			Result: biz.AuditAllowed, Reason: "bound verified email grants for " + email,
		}
		var err error
		rev, err = changeTx(ctx, tx, audit, func(tx pgx.Tx, rev int64) error {
			// Keep existing grants on the same scope and role, then bind the remaining pending grants.
			if _, err := tx.Exec(ctx, `DELETE FROM grants AS pending USING grants AS existing
				WHERE pending.subject_type = 'email' AND pending.subject = $1 AND pending.subject_issuer = $2
				AND existing.subject_type = 'user' AND existing.subject = $3 AND existing.subject_issuer = ''
				AND (pending.resource_type, pending.namespace, pending.name, pending.role)
				  = (existing.resource_type, existing.namespace, existing.name, existing.role)`, email, r.issuer, user.Subject); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `UPDATE grants SET subject_type = 'user', subject = $3, subject_issuer = '', revision = $4
				WHERE subject_type = 'email' AND subject = $1 AND subject_issuer = $2`, email, r.issuer, user.Subject, rev)
			return err
		})
		return err
	})
	return rev, err
}
