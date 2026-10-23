//go:build wireinject
// +build wireinject

// The build tag makes sure the stub is not built in the final build.

package main

import (
	"argonaut/internal/authz"
	"argonaut/internal/biz"
	"argonaut/internal/data"
	"argonaut/internal/log"
	"argonaut/internal/oidc"
	"argonaut/internal/server"
	"argonaut/internal/service"
	"argonaut/pkg/argo"

	"github.com/google/wire"
)

// There are two injectors because the commands need genuinely different things. Serving requires a
// live Kubernetes connection and a compiled policy; migrating requires only the database. A single
// graph would make `migrate` fail whenever the cluster is unreachable — exactly the situation where
// you are most likely to be bootstrapping the database.

var configProviders = wire.NewSet(
	newConf,
	newServerConf,
	newDataConf,
	newLogConf,
	newSSOConf,
	newKubeConf,
	newArgoConf,
	newClusterSwitchConf,
	newAuthzConf,
)

func initServerApp(log.NameString, log.VersionString) (*ServerCommand, func(), error) {
	panic(wire.Build(
		configProviders,
		newRootCmd,
		NewAppContext,
		NewServerCmd,
		log.ProviderSet,
		authz.ProviderSet,
		biz.ProviderSet,
		data.ProviderSet,
		service.ProviderSet,
		server.ProviderSet,
		oidc.ProviderSet,
		argo.ProviderSet,
	))
}

func initMigrateApp(log.NameString, log.VersionString) (*MigrateCommand, func(), error) {
	panic(wire.Build(
		configProviders,
		newRootCmd,
		NewMigrateCmd,
		log.ProviderSet,
	))
}
