package data

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"argonaut/internal/authz"
	"argonaut/internal/biz"
	"argonaut/pkg/id"

	kerrors "github.com/go-kratos/kratos/v3/errors"
	"github.com/jackc/pgx/v5"
)

// notifyChannel carries the new revision after every committed authorization change.
const notifyChannel = "argonaut_authz"

type authzRepo struct {
	data *Data
}

// NewAuthzRepo returns the grants / policies / revision repository.
func NewAuthzRepo(data *Data) biz.AuthzRepo {
	return &authzRepo{data: data}
}

func (r *authzRepo) Revision(ctx context.Context) (int64, error) {
	var rev int64
	err := r.data.pool.QueryRow(ctx, `SELECT revision FROM authz_meta WHERE id = 1`).Scan(&rev)
	return rev, err
}

// Snapshot reads the revision, grants and policies in one REPEATABLE READ transaction, so they are
// guaranteed to belong together: a write committing between the three reads cannot produce a
// snapshot labelled with one revision but holding another revision's grants.
func (r *authzRepo) Snapshot(ctx context.Context) (authz.Snapshot, error) {
	var snap authz.Snapshot
	err := pgx.BeginTxFunc(ctx, r.data.pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT revision FROM authz_meta WHERE id = 1`).Scan(&snap.Revision); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT id, subject_type, subject, resource_type, namespace, name, role, created_by, created_at, revision
			FROM grants ORDER BY created_at, id`)
		if err != nil {
			return err
		}
		grants, err := pgx.CollectRows(rows, scanGrant)
		if err != nil {
			return err
		}
		snap.Grants = grants
		rows, err = tx.Query(ctx, `SELECT id, name, description, body, enabled, created_by, created_at, revision
			FROM authz_policies ORDER BY created_at, id`)
		if err != nil {
			return err
		}
		policies, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (authz.CustomPolicy, error) {
			var p authz.CustomPolicy
			var numeric int64
			err := row.Scan(&numeric, &p.Name, &p.Description, &p.Body, &p.Enabled, &p.CreatedBy, &p.CreatedAt, &p.Revision)
			p.ID = strconv.FormatInt(numeric, 10)
			return p, err
		})
		snap.Policies = policies
		return err
	})
	return snap, err
}

func scanGrant(row pgx.CollectableRow) (authz.Grant, error) {
	var g authz.Grant
	var numeric int64
	err := row.Scan(&numeric, &g.SubjectType, &g.Subject, &g.ResourceType, &g.Namespace, &g.Name, &g.Role, &g.CreatedBy, &g.CreatedAt, &g.Revision)
	g.ID = strconv.FormatInt(numeric, 10)
	if g.ResourceType == authz.ResourceNamespace || g.ResourceType == authz.ResourceGlobal {
		g.Name = ""
	}
	return g, err
}

func (r *authzRepo) GetGrant(ctx context.Context, idStr string) (authz.Grant, error) {
	numeric, err := parseID(idStr)
	if err != nil {
		return authz.Grant{}, err
	}
	rows, err := r.data.pool.Query(ctx, `SELECT id, subject_type, subject, resource_type, namespace, name, role, created_by, created_at, revision
		FROM grants WHERE id = $1`, numeric)
	if err != nil {
		return authz.Grant{}, err
	}
	g, err := pgx.CollectExactlyOneRow(rows, scanGrant)
	if errors.Is(err, pgx.ErrNoRows) {
		return authz.Grant{}, kerrors.NotFound("not_found", "grant not found")
	}
	return g, err
}

// change runs one authorization write: fn performs it, then the revision is bumped, the audit event
// stamped with the new revision, and the other replicas notified — all committed together, so no
// replica can observe the new revision without the change it stands for.
func (r *authzRepo) change(ctx context.Context, audit biz.AuditEvent, fn func(tx pgx.Tx, rev int64) error) (int64, error) {
	var rev int64
	err := pgx.BeginFunc(ctx, r.data.pool, func(tx pgx.Tx) error {
		// The row lock also serializes concurrent writers, so revisions are handed out in commit order.
		if err := tx.QueryRow(ctx, `UPDATE authz_meta SET revision = revision + 1 WHERE id = 1 RETURNING revision`).Scan(&rev); err != nil {
			return err
		}
		if err := fn(tx, rev); err != nil {
			return err
		}
		audit.Revision = rev
		if err := insertAudit(ctx, tx, audit); err != nil {
			return err
		}
		// NOTIFY is delivered at commit, and not at all if the transaction rolls back.
		_, err := tx.Exec(ctx, `SELECT pg_notify($1, $2)`, notifyChannel, strconv.FormatInt(rev, 10))
		return err
	})
	return rev, err
}

func (r *authzRepo) CreateGrant(ctx context.Context, g authz.Grant, audit biz.AuditEvent) (authz.Grant, int64, error) {
	// Granting the same thing twice is a no-op rather than an error, so the UI can be clicked twice.
	var existingID int64
	err := r.data.pool.QueryRow(ctx, `SELECT id FROM grants WHERE subject_type=$1 AND subject=$2 AND resource_type=$3 AND namespace=$4 AND name=$5 AND role=$6`,
		g.SubjectType, g.Subject, g.ResourceType, g.Namespace, storedName(g), g.Role).Scan(&existingID)
	if err == nil {
		existing, err := r.GetGrant(ctx, strconv.FormatInt(existingID, 10))
		if err != nil {
			return authz.Grant{}, 0, err
		}
		rev, err := r.Revision(ctx)
		return existing, rev, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return authz.Grant{}, 0, err
	}

	newID := id.Generate()
	rev, err := r.change(ctx, audit, func(tx pgx.Tx, rev int64) error {
		_, err := tx.Exec(ctx, `INSERT INTO grants (id, subject_type, subject, resource_type, namespace, name, role, created_by, revision)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			newID, g.SubjectType, g.Subject, g.ResourceType, g.Namespace, storedName(g), g.Role, g.CreatedBy, rev)
		return err
	})
	if err != nil {
		return authz.Grant{}, 0, err
	}
	created, err := r.GetGrant(ctx, strconv.FormatInt(newID, 10))
	return created, rev, err
}

// storedName keeps the pre-existing column contract: namespace and global grants store "*".
func storedName(g authz.Grant) string {
	if g.ResourceType == authz.ResourceNamespace || g.ResourceType == authz.ResourceGlobal {
		return authz.Wildcard
	}
	return g.Name
}

func (r *authzRepo) DeleteGrant(ctx context.Context, idStr string, audit biz.AuditEvent) (int64, error) {
	numeric, err := parseID(idStr)
	if err != nil {
		return 0, err
	}
	return r.change(ctx, audit, func(tx pgx.Tx, _ int64) error {
		tag, err := tx.Exec(ctx, `DELETE FROM grants WHERE id = $1`, numeric)
		if err == nil && tag.RowsAffected() == 0 {
			return kerrors.NotFound("not_found", "grant not found")
		}
		return err
	})
}

func (r *authzRepo) DeleteGrantsOn(ctx context.Context, resourceType, namespace, name string, audit biz.AuditEvent) (int64, error) {
	var count int
	if err := r.data.pool.QueryRow(ctx, `SELECT count(*) FROM grants WHERE resource_type=$1 AND namespace=$2 AND name=$3`,
		resourceType, namespace, name).Scan(&count); err != nil {
		return 0, err
	}
	if count == 0 {
		return 0, nil
	}
	return r.change(ctx, audit, func(tx pgx.Tx, _ int64) error {
		_, err := tx.Exec(ctx, `DELETE FROM grants WHERE resource_type=$1 AND namespace=$2 AND name=$3`, resourceType, namespace, name)
		return err
	})
}

func (r *authzRepo) CreatePolicy(ctx context.Context, p authz.CustomPolicy, audit biz.AuditEvent) (authz.CustomPolicy, int64, error) {
	newID := id.Generate()
	rev, err := r.change(ctx, audit, func(tx pgx.Tx, rev int64) error {
		_, err := tx.Exec(ctx, `INSERT INTO authz_policies (id, name, description, body, enabled, created_by, revision)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`, newID, p.Name, p.Description, p.Body, p.Enabled, p.CreatedBy, rev)
		if err != nil && isUniqueViolation(err) {
			return kerrors.Conflict("already_exists", fmt.Sprintf("a policy named %q already exists", p.Name))
		}
		return err
	})
	if err != nil {
		return authz.CustomPolicy{}, 0, err
	}
	p.ID = strconv.FormatInt(newID, 10)
	p.Revision = rev
	p.CreatedAt = time.Now()
	return p, rev, nil
}

func (r *authzRepo) SetPolicyEnabled(ctx context.Context, idStr string, enabled bool, audit biz.AuditEvent) (int64, error) {
	numeric, err := parseID(idStr)
	if err != nil {
		return 0, err
	}
	return r.change(ctx, audit, func(tx pgx.Tx, rev int64) error {
		tag, err := tx.Exec(ctx, `UPDATE authz_policies SET enabled = $2, revision = $3 WHERE id = $1`, numeric, enabled, rev)
		if err == nil && tag.RowsAffected() == 0 {
			return kerrors.NotFound("not_found", "policy not found")
		}
		return err
	})
}

func (r *authzRepo) DeletePolicy(ctx context.Context, idStr string, audit biz.AuditEvent) (int64, error) {
	numeric, err := parseID(idStr)
	if err != nil {
		return 0, err
	}
	return r.change(ctx, audit, func(tx pgx.Tx, _ int64) error {
		tag, err := tx.Exec(ctx, `DELETE FROM authz_policies WHERE id = $1`, numeric)
		if err == nil && tag.RowsAffected() == 0 {
			return kerrors.NotFound("not_found", "policy not found")
		}
		return err
	})
}

// Listen holds a dedicated connection with LISTEN registered and reports each notified revision.
func (r *authzRepo) Listen(ctx context.Context, onRevision func(int64)) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := r.listenOnce(ctx, onRevision)
		if ctx.Err() != nil {
			return
		}
		r.data.log.Warn("authz LISTEN connection lost; polling covers the gap until it reconnects", "err", err, "retryIn", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (r *authzRepo) listenOnce(ctx context.Context, onRevision func(int64)) error {
	conn, err := pgx.Connect(ctx, r.data.source)
	if err != nil {
		return err
	}
	defer conn.Close(context.WithoutCancel(ctx))
	if _, err := conn.Exec(ctx, "LISTEN "+notifyChannel); err != nil {
		return err
	}
	// A notification may have been missed while disconnected; check once now that we are listening.
	var rev int64
	if err := conn.QueryRow(ctx, `SELECT revision FROM authz_meta WHERE id = 1`).Scan(&rev); err == nil {
		onRevision(rev)
	}
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		if v, err := strconv.ParseInt(n.Payload, 10, 64); err == nil {
			onRevision(v)
		}
	}
}

func (r *authzRepo) Heartbeat(ctx context.Context, replica string, revision int64) error {
	_, err := r.data.pool.Exec(ctx, `INSERT INTO authz_replicas (id, revision, seen_at) VALUES ($1, $2, now())
		ON CONFLICT (id) DO UPDATE SET revision = EXCLUDED.revision, seen_at = now()`, replica, revision)
	return err
}

func (r *authzRepo) Replicas(ctx context.Context, since time.Time) ([]biz.Replica, error) {
	rows, err := r.data.pool.Query(ctx, `SELECT id, revision, seen_at FROM authz_replicas WHERE seen_at >= $1 ORDER BY id`, since)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (biz.Replica, error) {
		var rep biz.Replica
		err := row.Scan(&rep.ID, &rep.Revision, &rep.SeenAt)
		return rep, err
	})
}

func parseID(idStr string) (int64, error) {
	numeric, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		return 0, kerrors.BadRequest("invalid_argument", fmt.Sprintf("invalid id %q", idStr))
	}
	return numeric, nil
}
