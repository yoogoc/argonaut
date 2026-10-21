// Command archive-seed fills a workflow archive database for development. The Argo controller is
// what archives runs in a real install; this copies finished workflows of one namespace into the
// archive described by a controller ConfigMap's persistence section, so the archive pages can be
// exercised without reconfiguring the cluster's controller.
//
//	go run ./hack/archive-seed -configmap argonaut-dev-controller-configmap -namespace argo
package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/argoproj/argo-workflows/v4/config"
	persist "github.com/argoproj/argo-workflows/v4/persist/sqldb"
	wfclientset "github.com/argoproj/argo-workflows/v4/pkg/client/clientset/versioned"
	"github.com/argoproj/argo-workflows/v4/util/instanceid"
	"github.com/argoproj/argo-workflows/v4/util/logging"
	"github.com/argoproj/argo-workflows/v4/util/sqldb"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
	"sigs.k8s.io/yaml"
)

func main() {
	controllerNS := flag.String("controller-namespace", "argo", "namespace of the controller ConfigMap")
	configMap := flag.String("configmap", "argonaut-dev-controller-configmap", "ConfigMap with a persistence section")
	namespace := flag.String("namespace", "argo", "namespace whose finished workflows are archived")
	flag.Parse()
	if err := run(*controllerNS, *configMap, *namespace); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(controllerNS, configMap, namespace string) error {
	ctx := logging.WithLogger(context.Background(), logging.NewSlogLogger(logging.Info, logging.Text))
	rest, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(clientcmd.NewDefaultClientConfigLoadingRules(), nil).ClientConfig()
	if err != nil {
		return err
	}
	kube := kubernetes.NewForConfigOrDie(rest)
	wfc := wfclientset.NewForConfigOrDie(rest)

	cm, err := kube.CoreV1().ConfigMaps(controllerNS).Get(ctx, configMap, metav1.GetOptions{})
	if err != nil {
		return err
	}
	var cfg config.Config
	if err := yaml.Unmarshal([]byte(cm.Data["config"]), &cfg); err != nil {
		return err
	}
	if cfg.Persistence == nil {
		return fmt.Errorf("%s/%s has no persistence section", controllerNS, configMap)
	}
	proxy, err := sqldb.NewSessionProxy(ctx, sqldb.SessionProxyConfig{KubectlConfig: kube, Namespace: controllerNS, DBConfig: cfg.Persistence.DBConfig})
	if err != nil {
		return err
	}
	tableName, err := persist.GetTableName(cfg.Persistence)
	if err != nil {
		return err
	}
	if err := persist.Migrate(ctx, proxy.Session(), cfg.Persistence.GetClusterName(), tableName, proxy.DBType()); err != nil {
		return err
	}
	archive := persist.NewWorkflowArchive(proxy, cfg.Persistence.GetClusterName(), "", instanceid.NewService(cfg.InstanceID))

	list, err := wfc.ArgoprojV1alpha1().Workflows(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return err
	}
	n := 0
	for i := range list.Items {
		wf := &list.Items[i]
		if !wf.Status.Fulfilled() {
			continue
		}
		if err := archive.ArchiveWorkflow(ctx, wf); err != nil {
			return fmt.Errorf("archiving %s: %w", wf.Name, err)
		}
		n++
	}
	fmt.Printf("archived %d finished workflows from %s\n", n, namespace)
	return nil
}
