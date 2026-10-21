package data

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"argonaut/internal/conf"

	"github.com/google/wire"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ProviderSet is the data providers.
var ProviderSet = wire.NewSet(
	NewData,
	NewAuthzRepo,
	NewAuditRepo,
	NewRevisionRepo,
)

// Data holds the database pool. argonaut persists authorization data, the audit log and template
// history; workflow, template and cron content always comes straight from Kubernetes.
type Data struct {
	log  *slog.Logger
	pool *pgxpool.Pool
	// source is kept for the dedicated LISTEN connection, which must not come from the pool: a pooled
	// connection is returned and reused, and its LISTEN registration would leak to other users.
	source string
}

func NewData(dataConf *conf.Data, logger *slog.Logger) (*Data, func(), error) {
	l := logger.With("module", "data")
	source := dataConf.GetDatabase().GetSource()
	cfg, err := pgxpool.ParseConfig(source)
	if err != nil {
		return nil, nil, fmt.Errorf("parsing database source: %w", err)
	}
	cfg.MaxConnIdleTime = 5 * time.Minute
	// Connecting lazily keeps a slow database from failing startup: super admins can still work
	// (DESIGN §4.2) and the health endpoint answers, while authorization reports the outage per request.
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		return nil, nil, fmt.Errorf("opening database pool: %w", err)
	}
	cleanup := func() { pool.Close() }
	return &Data{log: l, pool: pool, source: source}, cleanup, nil
}
