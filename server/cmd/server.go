package main

import (
	"log/slog"

	"github.com/go-kratos/kratos/v3"
	"github.com/go-kratos/kratos/v3/transport/http"
	"github.com/spf13/cobra"
)

type ServerCommand cobra.Command

func NewServerCmd(logger *slog.Logger, hs *http.Server) *ServerCommand {
	return &ServerCommand{
		Use:                "server",
		Short:              "start the server",
		Long:               "start the argonaut HTTP server",
		FParseErrWhitelist: cobra.FParseErrWhitelist{UnknownFlags: true},
		RunE: func(_ *cobra.Command, _ []string) error {
			app := kratos.New(
				kratos.Name(Name),
				kratos.Version(Version),
				kratos.Metadata(map[string]string{}),
				kratos.Logger(logger),
				kratos.Server(hs),
			)
			return app.Run()
		},
	}
}
