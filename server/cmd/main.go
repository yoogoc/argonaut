package main

import (
	"fmt"
	"os"
	"strings"

	defaultconfigs "argonaut/configs"
	"argonaut/internal/conf"
	ilog "argonaut/internal/log"

	"github.com/spf13/cobra"
	kitconfig "github.com/yoogoc/kratos-kit/config/loader"
)

// go build -ldflags "-X main.Version=x.y.z"
var (
	// Name is the name of the compiled software.
	Name = "argonaut"
	// Version is the version of the compiled software.
	Version string

	flagconf string
	// closeConf stops the config sources' watchers once the command returns.
	closeConf func() error
)

type RootCommand cobra.Command

// Only the requested command's dependencies are constructed. Building the server graph reaches out
// to Kubernetes and compiles the authorization policy, which `migrate` and `--help` have no business
// requiring.
func main() {
	name, version := ilog.NameString(Name), ilog.VersionString(Version)

	var (
		cmd     *cobra.Command
		cleanup func()
		err     error
	)
	switch subcommand(os.Args[1:]) {
	case "server":
		var server *ServerCommand
		server, cleanup, err = initServerApp(name, version)
		if err == nil {
			cmd = attach(newRootCmd(), (*cobra.Command)(server))
		}
	case "migrate":
		var migrate *MigrateCommand
		migrate, cleanup, err = initMigrateApp(name, version)
		if err == nil {
			cmd = attach(newRootCmd(), (*cobra.Command)(migrate))
		}
	default:
		// No recognised subcommand: describe what is available without constructing anything.
		usage()
		return
	}
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if cleanup != nil {
		defer cleanup()
	}
	defer func() {
		if closeConf != nil {
			_ = closeConf()
		}
	}()

	if err := cmd.Execute(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// subcommand returns the first positional argument, ignoring flags.
func subcommand(args []string) string {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "-") {
			return arg
		}
		// Skip the value of a flag written with a space, e.g. "-c ./configs".
		if !strings.Contains(arg, "=") && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
			i++
		}
	}
	return ""
}

func attach(root *RootCommand, sub *cobra.Command) *cobra.Command {
	(*cobra.Command)(root).AddCommand(sub)
	return (*cobra.Command)(root)
}

func usage() {
	root := (*cobra.Command)(newRootCmd())
	root.AddCommand(
		&cobra.Command{Use: "server", Short: "start the argonaut HTTP server"},
		&cobra.Command{Use: "migrate", Short: "migrate the database (goose)"},
	)
	_ = root.Help()
}

func newConf(rootCmd *RootCommand) *conf.Bootstrap {
	flags := (*cobra.Command)(rootCmd).PersistentFlags()
	flags.StringVarP(&flagconf, "config", "c", "", "additional config file or directory, applied over the defaults and configs/local")
	_ = flags.Parse(os.Args[1:])

	// Layered like kratos-scaffold projects (later wins): the defaults compiled into the binary,
	// Git-ignored overrides in ./configs/local, an explicit --config, then ARGONAUT_X environment
	// variables, which fill ${X} placeholders (the Helm chart mounts DATABASE_URL, JWT_SECRET and
	// SSO_CLIENT_SECRET from a Secret).
	var bc conf.Bootstrap
	closeConfig, err := kitconfig.Load(&bc, kitconfig.Options{
		Defaults:     defaultconfigs.DefaultFS,
		DefaultRoots: []string{"default"},
		LocalRoots:   []string{"./configs/local"},
		ExplicitPath: flagconf,
		EnvPrefix:    "ARGONAUT_",
	})
	if err != nil {
		// A bad --config path is a usage mistake, not a crash: say what to fix instead of panicking.
		_, _ = fmt.Fprintf(os.Stderr, "loading config: %v\n(--config adds a file or directory over the built-in defaults and ./configs/local; omit it to run with those alone)\n", err)
		os.Exit(2)
	}
	closeConf = closeConfig
	return &bc
}

// Each section gets its own provider so components depend only on the configuration they use, and a
// missing section yields an empty message with working defaults rather than a nil dereference.
func newServerConf(bc *conf.Bootstrap) *conf.Server {
	if bc.Server == nil {
		return &conf.Server{}
	}
	return bc.Server
}

func newDataConf(bc *conf.Bootstrap) *conf.Data {
	if bc.Data == nil {
		return &conf.Data{}
	}
	return bc.Data
}

func newLogConf(bc *conf.Bootstrap) *conf.Log {
	if bc.Log == nil {
		return &conf.Log{}
	}
	return bc.Log
}

func newSSOConf(bc *conf.Bootstrap) *conf.SSO {
	if bc.Sso == nil {
		return &conf.SSO{}
	}
	return bc.Sso
}

func newKubeConf(bc *conf.Bootstrap) *conf.Kube {
	if bc.Kube == nil {
		return &conf.Kube{}
	}
	return bc.Kube
}

func newClusterSwitchConf(bc *conf.Bootstrap) *conf.ClusterSwitch {
	if bc.ClusterSwitch == nil {
		return &conf.ClusterSwitch{}
	}
	return bc.ClusterSwitch
}

func newArgoConf(bc *conf.Bootstrap) *conf.Argo {
	if bc.Argo == nil {
		return &conf.Argo{}
	}
	return bc.Argo
}

func newAuthzConf(bc *conf.Bootstrap) *conf.Authz {
	if bc.Authz == nil {
		return &conf.Authz{}
	}
	return bc.Authz
}

func newRootCmd() *RootCommand {
	return &RootCommand{
		Use:                Name,
		Short:              "argonaut server",
		Long:               "argonaut server: an Argo Workflows console with OIDC login and OPA authorization",
		FParseErrWhitelist: cobra.FParseErrWhitelist{UnknownFlags: true},
		Run: func(cmd *cobra.Command, _ []string) {
			_ = cmd.Help()
		},
	}
}
