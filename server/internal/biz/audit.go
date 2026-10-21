package biz

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"argonaut/internal/authz"
	"argonaut/internal/viewer"
)

// Audit results.
const (
	AuditAllowed  = "allowed"
	AuditDenied   = "denied"
	AuditRecorded = "recorded"
)

// AuditEvent is one row of the audit log: a write argonaut performed, a request it refused, or an
// observation (a template changed outside argonaut).
type AuditEvent struct {
	ID           string
	At           time.Time
	Actor        string
	Action       string
	ResourceType string
	Namespace    string
	Name         string
	Result       string
	Reason       string
	Detail       json.RawMessage
	Revision     int64
}

// AuditFilter narrows an audit listing.
type AuditFilter struct {
	Actor  string
	Action string
	Result string
	Limit  int
	Offset int
}

// AuditRepo persists the audit log.
type AuditRepo interface {
	Record(ctx context.Context, ev AuditEvent) error
	List(ctx context.Context, f AuditFilter) ([]AuditEvent, int, error)
	Latest(ctx context.Context, actions []string) (*AuditEvent, error)
}

// Auditor records what callers did. Writes never fail the operation they describe: the operation has
// already happened on the cluster by the time it is recorded, and refusing to report success because
// the log could not be written would only make the caller retry something that worked.
type Auditor struct {
	log  *slog.Logger
	repo AuditRepo
}

func NewAuditor(repo AuditRepo, logger *slog.Logger) *Auditor {
	return &Auditor{log: logger.With("module", "biz/audit"), repo: repo}
}

// Record writes an event for the caller in ctx.
func (a *Auditor) Record(ctx context.Context, action authz.Action, res authz.Resource, result, reason string, detail any, revision int64) {
	ev := AuditEvent{
		Actor:        viewer.Subject(ctx),
		Action:       string(action),
		ResourceType: res.Kind(),
		Namespace:    res.Namespace,
		Name:         res.Name(),
		Result:       result,
		Reason:       reason,
		Revision:     revision,
	}
	if res.Kind() == authz.ResourceNamespace {
		ev.Name = ""
	}
	if detail != nil {
		if raw, err := json.Marshal(detail); err == nil {
			ev.Detail = raw
		}
	}
	a.write(ctx, ev)
}

// RecordEvent writes a fully formed event (used for observations without a caller).
func (a *Auditor) RecordEvent(ctx context.Context, ev AuditEvent) {
	a.write(ctx, ev)
}

func (a *Auditor) write(ctx context.Context, ev AuditEvent) {
	// Detach from the request: the caller may already have disconnected, and the record must still land.
	ctx = context.WithoutCancel(ctx)
	if err := a.repo.Record(ctx, ev); err != nil {
		a.log.Error("writing audit event failed", "err", err, "actor", ev.Actor, "action", ev.Action, "name", ev.Name)
	}
}

func (a *Auditor) List(ctx context.Context, f AuditFilter) ([]AuditEvent, int, error) {
	return a.repo.List(ctx, f)
}
