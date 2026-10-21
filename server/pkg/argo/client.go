// Package argo runs Argo Workflows' own server packages in-process against the Kubernetes API.
//
// argonaut never calls argo-server. Instead this package assembles the very same servers that
// server/apiserver/argoserver.go builds — workflow, workflow template, cron workflow and the
// artifact HTTP server — wired to a direct client-go connection. That way every runtime behaviour
// the official UI depends on (node status hydration, artifact repository resolution, retry/resubmit
// semantics, log streaming) is Argo's real implementation rather than a reimplementation.
package argo

import (
	"context"
	"fmt"
	"log/slog"

	"argonaut/internal/conf"

	"github.com/argoproj/argo-workflows/v4/config"
	persist "github.com/argoproj/argo-workflows/v4/persist/sqldb"
	cronworkflowpkg "github.com/argoproj/argo-workflows/v4/pkg/apiclient/cronworkflow"
	workflowpkg "github.com/argoproj/argo-workflows/v4/pkg/apiclient/workflow"
	workflowtemplatepkg "github.com/argoproj/argo-workflows/v4/pkg/apiclient/workflowtemplate"
	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	wfclientset "github.com/argoproj/argo-workflows/v4/pkg/client/clientset/versioned"
	"github.com/argoproj/argo-workflows/v4/server/clusterworkflowtemplate"
	cronworkflowserver "github.com/argoproj/argo-workflows/v4/server/cronworkflow"
	servertypes "github.com/argoproj/argo-workflows/v4/server/types"
	workflowserver "github.com/argoproj/argo-workflows/v4/server/workflow"
	"github.com/argoproj/argo-workflows/v4/server/workflow/store"
	workflowtemplateserver "github.com/argoproj/argo-workflows/v4/server/workflowtemplate"
	"github.com/argoproj/argo-workflows/v4/util/instanceid"
	"github.com/argoproj/argo-workflows/v4/util/logging"
	"github.com/argoproj/argo-workflows/v4/util/sqldb"
	"github.com/argoproj/argo-workflows/v4/workflow/artifactrepositories"
	"github.com/argoproj/argo-workflows/v4/workflow/hydrator"
	"github.com/google/wire"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// ProviderSet is the argo providers.
var ProviderSet = wire.NewSet(NewClients, NewServers)

// argoLogger adapts to Argo's own logging interface, which v4 requires when constructing the
// persistence repositories. Its output goes through slog like everything else.
func argoLogger() logging.Logger {
	return logging.NewSlogLogger(logging.Info, logging.JSON)
}

const (
	defaultControllerNamespace = "argo"
	defaultControllerConfigMap = "workflow-controller-configmap"

	// client-go defaults to QPS=5/Burst=10. A single workflow detail page (full Get, watch, and
	// per-node log streams) exhausts that and fails with "client rate limiter Wait ... context
	// deadline exceeded". Argo's own server raises these limits, so we do too.
	defaultQPS   = 50
	defaultBurst = 100
)

// Clients holds the Kubernetes connections shared by every Argo server.
type Clients struct {
	RestConfig *rest.Config
	Kubernetes kubernetes.Interface
	Workflow   wfclientset.Interface
	Dynamic    dynamic.Interface
	// Namespace is the managed namespace, empty when running cluster-wide.
	Namespace string
}

// NewClients builds the Kubernetes clients from in-cluster config or a kubeconfig file.
func NewClients(kubeConf *conf.Kube, logger *slog.Logger) (*Clients, error) {
	log := logger.With("module", "argo/clients")

	restConfig, contextName, err := restConfig(kubeConf)
	if err != nil {
		return nil, fmt.Errorf("building kubernetes rest config: %w", err)
	}
	restConfig.QPS = float32(defaultQPS)
	if kubeConf.GetQps() > 0 {
		restConfig.QPS = float32(kubeConf.GetQps())
	}
	restConfig.Burst = defaultBurst
	if kubeConf.GetBurst() > 0 {
		restConfig.Burst = int(kubeConf.GetBurst())
	}

	kubeClient, err := kubernetes.NewForConfig(restConfig)
	if err != nil {
		return nil, fmt.Errorf("creating kubernetes client: %w", err)
	}
	wfClient, err := wfclientset.NewForConfig(restConfig)
	if err != nil {
		return nil, fmt.Errorf("creating argo workflow client: %w", err)
	}
	dynamicClient, err := dynamic.NewForConfig(restConfig)
	if err != nil {
		return nil, fmt.Errorf("creating dynamic client: %w", err)
	}

	// The cluster this console is attached to is logged explicitly: pointing at the wrong cluster is
	// the kind of mistake that is invisible until someone acts on data from it.
	log.Info("kubernetes clients ready",
		"host", restConfig.Host,
		"context", contextName,
		"managedNamespace", kubeConf.GetManagedNamespace())

	return &Clients{
		RestConfig: restConfig,
		Kubernetes: kubeClient,
		Workflow:   wfClient,
		Dynamic:    dynamicClient,
		Namespace:  kubeConf.GetManagedNamespace(),
	}, nil
}

// restConfig resolves the connection, returning the context name it settled on so it can be logged.
func restConfig(kubeConf *conf.Kube) (*rest.Config, string, error) {
	// In-cluster credentials win when present: a deployed server must not depend on a mounted
	// kubeconfig. A configured context is meaningless there, so it is only consulted for files.
	if kubeConf.GetKubeconfig() == "" {
		if cfg, err := rest.InClusterConfig(); err == nil {
			return cfg, "in-cluster", nil
		}
	}

	loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
	if path := kubeConf.GetKubeconfig(); path != "" {
		loadingRules.ExplicitPath = path
	}
	loadingRules.DefaultClientConfig = &clientcmd.DefaultClientConfig

	overrides := &clientcmd.ConfigOverrides{}
	if name := kubeConf.GetContext(); name != "" {
		overrides.CurrentContext = name
	}
	clientConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(loadingRules, overrides)

	cfg, err := clientConfig.ClientConfig()
	if err != nil {
		return nil, "", err
	}

	contextName := kubeConf.GetContext()
	if contextName == "" {
		// Report the context that was actually used, since it came from the ambient kubeconfig.
		if raw, rawErr := clientConfig.RawConfig(); rawErr == nil {
			contextName = raw.CurrentContext
		}
	}
	return cfg, contextName, nil
}

// Servers exposes Argo's server implementations plus the runtime facts discovered from the cluster.
type Servers struct {
	Workflow         workflowpkg.WorkflowServiceServer
	WorkflowTemplate workflowtemplatepkg.WorkflowTemplateServiceServer
	CronWorkflow     cronworkflowpkg.CronWorkflowServiceServer
	// Artifacts reads artifacts straight from the object store. We use our own reader rather than
	// mounting Argo's ArtifactServer: its handlers parse fixed URL path offsets and authorize via
	// Kubernetes SelfSubjectAccessReview, neither of which fits argonaut's routes or its OPA model.
	Artifacts *ArtifactReader

	Clients   *Clients
	Config    *config.Config
	Hydrator  hydrator.Interface
	Instance  instanceid.Service
	Namespace string
	// OffloadEnabled records whether the controller ConfigMap declared node status offload, which
	// is surfaced to the UI so large workflows aren't silently truncated.
	OffloadEnabled bool

	log     *slog.Logger
	stopCh  chan struct{}
	tmplRun func(stopCh <-chan struct{})
}

// NewServers assembles the Argo servers, mirroring server/apiserver/argoserver.go.
func NewServers(ctx context.Context, clients *Clients, argoConf *conf.Argo, logger *slog.Logger) (*Servers, func(), error) {
	log := logger.With("module", "argo/servers")

	controllerNamespace := argoConf.GetControllerNamespace()
	if controllerNamespace == "" {
		controllerNamespace = clients.Namespace
	}
	if controllerNamespace == "" {
		controllerNamespace = defaultControllerNamespace
	}
	configMapName := argoConf.GetControllerConfigmap()
	if configMapName == "" {
		configMapName = defaultControllerConfigMap
	}

	// The controller ConfigMap is the single source of truth for artifact repositories, persistence
	// and links. Reading it at runtime is what lets argonaut work against any Argo install without
	// duplicating its configuration.
	argoConfig, err := readControllerConfig(ctx, clients.Kubernetes, controllerNamespace, configMapName)
	if err != nil {
		return nil, nil, err
	}

	instanceIDService := instanceid.NewService(argoConf.GetInstanceId())
	if argoConf.GetInstanceId() == "" {
		instanceIDService = instanceid.NewService(argoConfig.InstanceID)
	}

	offloadRepo := persist.ExplosiveOffloadNodeStatusRepo
	wfArchive := persist.NullWorkflowArchive
	offloadEnabled := false
	if persistence := argoConfig.Persistence; persistence != nil {
		// v4 reaches the persistence database through a SessionProxy, which reconnects and refreshes
		// cloud database credentials on its own.
		sessionProxy, err := sqldb.NewSessionProxy(ctx, sqldb.SessionProxyConfig{
			KubectlConfig: clients.Kubernetes,
			Namespace:     controllerNamespace,
			DBConfig:      persistence.DBConfig,
		})
		if err != nil {
			return nil, nil, fmt.Errorf("connecting to the argo persistence database: %w", err)
		}
		tableName, err := persist.GetTableName(persistence)
		if err != nil {
			return nil, nil, fmt.Errorf("resolving offload table name: %w", err)
		}
		// Offload reads are always enabled once a persistence DB exists: we only read, so a
		// controller that has offloading turned off still lets us read older offloaded records.
		offloadRepo, err = persist.NewOffloadNodeStatusRepo(ctx, argoLogger(), sessionProxy, persistence.GetClusterName(), tableName)
		if err != nil {
			return nil, nil, fmt.Errorf("opening offload node status repo: %w", err)
		}
		wfArchive = persist.NewWorkflowArchive(sessionProxy, persistence.GetClusterName(), clients.Namespace, instanceIDService)
		offloadEnabled = persistence.NodeStatusOffload
		log.Info("argo persistence detected", "nodeStatusOffload", persistence.NodeStatusOffload, "archive", persistence.Archive)
	} else {
		log.Info("argo persistence not configured; node status offload and archive unavailable")
	}

	stopCh := make(chan struct{})

	// The template informer serves template lookups during validation, which happens on every
	// submit and lint.
	wftmplInformer, err := workflowtemplateserver.NewInformer(clients.RestConfig, clients.Namespace)
	if err != nil {
		close(stopCh)
		return nil, nil, fmt.Errorf("creating workflow template informer: %w", err)
	}
	var wftmplStore servertypes.WorkflowTemplateStore = wftmplInformer
	// ClusterWorkflowTemplates are not a argonaut feature, so we use the lazy client store rather
	// than a cluster-scoped informer: nothing is cached or watched cluster-wide, but a template
	// that does reference a ClusterWorkflowTemplate still resolves when RBAC permits it.
	cwftmplStore := clusterworkflowtemplate.NewClientStore()

	artifactRepositories := artifactrepositories.New(clients.Kubernetes, controllerNamespace, &argoConfig.ArtifactRepository)
	wfHydrator := hydrator.New(offloadRepo)

	var namespace *string
	if clients.Namespace != "" {
		ns := clients.Namespace
		namespace = &ns
	}

	servers := &Servers{
		// v4 renamed these constructors and moved the context and artifact repositories into the
		// workflow server's signature.
		Workflow: workflowserver.NewServer(
			ctx,
			instanceIDService,
			offloadRepo,
			wfArchive,
			clients.Workflow,
			store.NewKubeLister(clients.Workflow),
			// A nil workflow store skips Argo's in-memory SQLite cache: it would duplicate every
			// workflow in memory for a read-mostly console that already talks straight to the API.
			nil,
			wftmplStore,
			cwftmplStore,
			argoConfig.WorkflowDefaults,
			namespace,
			artifactRepositories,
		),
		WorkflowTemplate: workflowtemplateserver.NewServer(instanceIDService, wftmplStore, cwftmplStore),
		CronWorkflow:     cronworkflowserver.NewCronWorkflowServer(instanceIDService, wftmplStore, cwftmplStore, argoConfig.WorkflowDefaults),
		Artifacts:        NewArtifactReader(clients, artifactRepositories),

		Clients:        clients,
		Config:         argoConfig,
		Hydrator:       wfHydrator,
		Instance:       instanceIDService,
		Namespace:      clients.Namespace,
		OffloadEnabled: offloadEnabled,

		log:     log,
		stopCh:  stopCh,
		tmplRun: func(stop <-chan struct{}) { wftmplInformer.Run(ctx, stop) },
	}

	servers.tmplRun(stopCh)
	log.Info("argo servers ready", "controllerConfigMap", controllerNamespace+"/"+configMapName, "instanceID", argoConfig.InstanceID)

	cleanup := func() {
		close(stopCh)
	}
	return servers, cleanup, nil
}

// WorkflowDefaults returns the cluster's configured workflow defaults, used when linting.
func (s *Servers) WorkflowDefaults() *wfv1.Workflow {
	return s.Config.WorkflowDefaults
}
