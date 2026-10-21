package data

import (
	stdsql "database/sql"
	"fmt"
	"log/slog"

	"argonaut/internal/conf"
	"argonaut/internal/data/ent"

	"entgo.io/ent/dialect/sql"
	"github.com/google/wire"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// ProviderSet is the data providers.
var ProviderSet = wire.NewSet(
	NewEntClient,
	NewData,
	NewGrantRepo,
)

// Data holds the database handle. argonaut persists only authorization grants — workflow, template
// and cron data always come straight from Kubernetes.
type Data struct {
	log *slog.Logger
	db  *ent.Client
}

func NewEntClient(dataConf *conf.Data, logger *slog.Logger) (*ent.Client, func(), error) {
	l := logger.With("module", "data/ent")

	driverName := dataConf.GetDatabase().GetDriver()
	switch driverName {
	case "postgres", "pg", "postgresql", "pgx":
		driverName = "pgx"
	}

	db, err := stdsql.Open(driverName, dataConf.GetDatabase().GetSource())
	if err != nil {
		return nil, nil, fmt.Errorf("opening database connection: %w", err)
	}

	var opts []ent.Option
	if dataConf.GetDatabase().GetEntDebug() {
		opts = append(opts, ent.Debug())
	}
	opts = append(opts, ent.Driver(sql.NewDriver(dataConf.GetDatabase().GetDriver(), sql.Conn{ExecQuerier: db})))

	client := ent.NewClient(opts...)
	cleanup := func() {
		if err := db.Close(); err != nil {
			l.Error("closing database", "err", err)
		}
	}
	return client, cleanup, nil
}

func NewData(logger *slog.Logger, db *ent.Client) *Data {
	return &Data{log: logger.With("module", "data"), db: db}
}
