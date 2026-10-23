package data

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"argonaut/internal/biz"
	"argonaut/pkg/id"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type auditRepo struct {
	data *Data
}

// NewAuditRepo returns the audit log repository.
func NewAuditRepo(data *Data) biz.AuditRepo {
	return &auditRepo{data: data}
}

type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

func insertAudit(ctx context.Context, db execer, ev biz.AuditEvent) error {
	var detail any
	if len(ev.Detail) > 0 {
		detail = string(ev.Detail)
	}
	_, err := db.Exec(ctx, `INSERT INTO audit_events (id, cluster, actor, action, resource_type, namespace, name, result, reason, detail, revision)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
		id.Generate(), ev.Cluster, ev.Actor, ev.Action, ev.ResourceType, ev.Namespace, ev.Name, ev.Result, ev.Reason, detail, ev.Revision)
	return err
}

func (r *auditRepo) Record(ctx context.Context, ev biz.AuditEvent) error {
	return insertAudit(ctx, r.data.pool, ev)
}

const auditColumns = `id, cluster, at, actor, action, resource_type, namespace, name, result, reason, COALESCE(detail::text, ''), revision`

func scanAudit(row pgx.CollectableRow) (biz.AuditEvent, error) {
	var ev biz.AuditEvent
	var numeric int64
	var detail string
	err := row.Scan(&numeric, &ev.Cluster, &ev.At, &ev.Actor, &ev.Action, &ev.ResourceType, &ev.Namespace, &ev.Name, &ev.Result, &ev.Reason, &detail, &ev.Revision)
	ev.ID = strconv.FormatInt(numeric, 10)
	if detail != "" {
		ev.Detail = []byte(detail)
	}
	return ev, err
}

func (r *auditRepo) List(ctx context.Context, f biz.AuditFilter) ([]biz.AuditEvent, int, error) {
	var where []string
	var args []any
	add := func(clause string, v any) {
		args = append(args, v)
		where = append(where, strings.ReplaceAll(clause, "?", "$"+strconv.Itoa(len(args))))
	}
	if f.Actor != "" {
		add("actor ILIKE ?", "%"+f.Actor+"%")
	}
	if f.Action != "" {
		add("action LIKE ?", f.Action+"%")
	}
	if f.Result != "" {
		add("result = ?", f.Result)
	}
	clause := ""
	if len(where) > 0 {
		clause = " WHERE " + strings.Join(where, " AND ")
	}
	var total int
	if err := r.data.pool.QueryRow(ctx, "SELECT count(*) FROM audit_events"+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	args = append(args, limit, f.Offset)
	rows, err := r.data.pool.Query(ctx, "SELECT "+auditColumns+" FROM audit_events"+clause+
		" ORDER BY at DESC, id DESC LIMIT $"+strconv.Itoa(len(args)-1)+" OFFSET $"+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	events, err := pgx.CollectRows(rows, scanAudit)
	return events, total, err
}

func (r *auditRepo) Latest(ctx context.Context, actions []string) (*biz.AuditEvent, error) {
	rows, err := r.data.pool.Query(ctx, "SELECT "+auditColumns+" FROM audit_events WHERE action = ANY($1) AND result = 'allowed' ORDER BY at DESC LIMIT 1", actions)
	if err != nil {
		return nil, err
	}
	ev, err := pgx.CollectExactlyOneRow(rows, scanAudit)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &ev, nil
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
