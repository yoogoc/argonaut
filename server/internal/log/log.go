package log

import (
	"argonaut/internal/conf"
	"log/slog"
	"os"

	"github.com/go-kratos/kratos/v3/log"
	"github.com/google/wire"
)

// log level: debug info warn error

type VersionString string
type NameString string

var ProviderSet = wire.NewSet(NewSlogLogger)

// AIDEV-NOTE: Kratos v3 rewrote logging on top of stdlib log/slog; kratos.New / logging.Server
// take *slog.Logger. We build a native v3 JSON slog logger here (zap dropped in the v3 upgrade)
// and attach service name/version as base attrs.
func NewSlogLogger(config *conf.Log, name NameString, version VersionString) *slog.Logger {
	if config == nil {
		config = new(conf.Log)
	}
	level := log.LevelDebug
	if config.Level != "" {
		level = log.ParseLevel(config.Level)
	}

	handler := log.NewHandler(
		log.WithWriter(os.Stdout),
		log.WithFormat(log.FormatJSON),
		log.WithLevel(level),
		log.WithAddSource(true),
	)
	logger := log.NewLogger(handler)

	slog.SetDefault(logger)

	return logger.With(
		"service.name", string(name),
		"service.version", string(version),
	)
}
