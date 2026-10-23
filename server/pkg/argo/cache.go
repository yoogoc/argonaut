package argo

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"argonaut/internal/conf"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/pkg/client/informers/externalversions"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/tools/cache"
)

// Cache keeps Argo resources in memory so lists and list-page watches never read a whole namespace
// from the API server per request (DESIGN §2.3). xyflow listed by paging through the namespace on every
// request — about ten seconds for two thousand workflows — and every watch replayed all of them.
//
// Workflows are stored stripped of their node status (see lightWorkflow): a list row needs a dozen
// fields, while a large workflow's status runs to megabytes. Detail pages fetch the full object.
type Cache struct {
	log       *slog.Logger
	factories []externalversions.SharedInformerFactory
	cluster   externalversions.SharedInformerFactory

	workflows     []cache.SharedIndexInformer
	templates     []cache.SharedIndexInformer
	crons         []cache.SharedIndexInformer
	clusterTpl    cache.SharedIndexInformer
	allNamespaces bool
	namespaces    map[string]bool

	mu        sync.RWMutex
	nextID    int
	wfSubs    map[int]workflowSub
	tplSubs   map[int]func(TemplateChange)
	synced    bool
	syncedAt  time.Time
	stopCh    chan struct{}
	syncError error
}

type workflowSub struct {
	namespace string
	fn        func(eventType string, wf *wfv1.Workflow)
}

// TemplateChange reports a WorkflowTemplate or ClusterWorkflowTemplate being added, updated or
// deleted. Initial is true for the adds that fill the cache at startup.
type TemplateChange struct {
	Cluster         bool
	Namespace       string
	Name            string
	Deleted         bool
	Initial         bool
	Template        *wfv1.WorkflowTemplate
	ClusterTemplate *wfv1.ClusterWorkflowTemplate
}

// NewCache starts informers for the managed namespaces (or the whole cluster when none are listed)
// and for ClusterWorkflowTemplates.
func NewCache(clients *Clients, servers *Servers, kubeConf *conf.Kube, logger *slog.Logger) (*Cache, func(), error) {
	log := logger.With("module", "argo/cache")
	c := &Cache{
		log:        log,
		namespaces: map[string]bool{},
		wfSubs:     map[int]workflowSub{},
		tplSubs:    map[int]func(TemplateChange){},
		stopCh:     make(chan struct{}),
	}
	tweak := func(opts *metav1.ListOptions) { servers.Instance.With(opts) }

	var namespaces []string
	switch {
	case clients.Namespace != "":
		namespaces = []string{clients.Namespace}
	case len(kubeConf.GetNamespaces()) > 0:
		namespaces = kubeConf.GetNamespaces()
	}
	if len(namespaces) == 0 {
		c.allNamespaces = true
		namespaces = []string{metav1.NamespaceAll}
	}
	for _, ns := range namespaces {
		c.namespaces[ns] = true
		wfFactory := externalversions.NewSharedInformerFactoryWithOptions(clients.Workflow, 0,
			externalversions.WithNamespace(ns),
			externalversions.WithTweakListOptions(tweak),
			externalversions.WithTransform(lightWorkflow))
		otherFactory := externalversions.NewSharedInformerFactoryWithOptions(clients.Workflow, 0,
			externalversions.WithNamespace(ns),
			externalversions.WithTweakListOptions(tweak),
			externalversions.WithTransform(stripManagedFields))
		c.factories = append(c.factories, wfFactory, otherFactory)
		c.workflows = append(c.workflows, wfFactory.Argoproj().V1alpha1().Workflows().Informer())
		c.templates = append(c.templates, otherFactory.Argoproj().V1alpha1().WorkflowTemplates().Informer())
		c.crons = append(c.crons, otherFactory.Argoproj().V1alpha1().CronWorkflows().Informer())
	}
	c.cluster = externalversions.NewSharedInformerFactoryWithOptions(clients.Workflow, 0,
		externalversions.WithTweakListOptions(tweak),
		externalversions.WithTransform(stripManagedFields))
	c.clusterTpl = c.cluster.Argoproj().V1alpha1().ClusterWorkflowTemplates().Informer()

	for _, inf := range c.workflows {
		if _, err := inf.AddEventHandler(cache.ResourceEventHandlerFuncs{
			AddFunc:    func(obj any) { c.dispatchWorkflow("ADDED", obj) },
			UpdateFunc: func(_, obj any) { c.dispatchWorkflow("MODIFIED", obj) },
			DeleteFunc: func(obj any) { c.dispatchWorkflow("DELETED", obj) },
		}); err != nil {
			return nil, nil, err
		}
	}
	for _, inf := range c.templates {
		if _, err := inf.AddEventHandler(c.templateHandler(false)); err != nil {
			return nil, nil, err
		}
	}
	if _, err := c.clusterTpl.AddEventHandler(c.templateHandler(true)); err != nil {
		return nil, nil, err
	}

	for _, f := range c.factories {
		f.Start(c.stopCh)
	}
	c.cluster.Start(c.stopCh)
	go c.waitForSync()

	log.Info("argo cache starting", "namespaces", namespaces)
	return c, func() { close(c.stopCh) }, nil
}

func (c *Cache) waitForSync() {
	var synced []cache.InformerSynced
	for _, group := range [][]cache.SharedIndexInformer{c.workflows, c.templates, c.crons, {c.clusterTpl}} {
		for _, inf := range group {
			synced = append(synced, inf.HasSynced)
		}
	}
	start := time.Now()
	ok := cache.WaitForCacheSync(c.stopCh, synced...)
	c.mu.Lock()
	c.synced = ok
	c.syncedAt = time.Now()
	if !ok {
		c.syncError = fmt.Errorf("argo cache did not sync")
	}
	c.mu.Unlock()
	if ok {
		c.log.Info("argo cache synced", "took", time.Since(start).Round(time.Millisecond), "workflows", c.count(c.workflows), "templates", c.count(c.templates))
	}
}

// WaitSynced blocks until the first full list has arrived, so the first request after startup does
// not see an empty cluster.
func (c *Cache) WaitSynced(ctx context.Context) error {
	for {
		c.mu.RLock()
		synced, err := c.synced, c.syncError
		c.mu.RUnlock()
		if synced || err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func (c *Cache) count(infs []cache.SharedIndexInformer) int {
	n := 0
	for _, inf := range infs {
		n += len(inf.GetStore().ListKeys())
	}
	return n
}

// Manages reports whether a namespace is covered by the cache.
func (c *Cache) Manages(namespace string) bool {
	return c.allNamespaces || c.namespaces[namespace]
}

// ---- reads ----

// WorkflowFilter selects workflows from the cache.
type WorkflowFilter struct {
	Namespace     string
	LabelSelector string
	NamePattern   string
	Phases        []string
	Parameters    []ParamFilter
	// Templates holds source keys as returned by WorkflowSource ("name" or "cluster/name").
	Templates []string
}

// ListWorkflows returns matching (light) workflows, newest first.
func (c *Cache) ListWorkflows(ctx context.Context, f WorkflowFilter) ([]*wfv1.Workflow, error) {
	if err := c.WaitSynced(ctx); err != nil {
		return nil, err
	}
	selector, err := parseSelector(f.LabelSelector)
	if err != nil {
		return nil, err
	}
	templates := map[string]bool{}
	for _, t := range f.Templates {
		if t = strings.TrimSpace(t); t != "" {
			templates[t] = true
		}
	}
	phases := map[string]bool{}
	for _, p := range f.Phases {
		if p = strings.TrimSpace(p); p != "" {
			phases[p] = true
		}
	}
	var out []*wfv1.Workflow
	for _, inf := range c.workflows {
		for _, obj := range listNamespace(inf, f.Namespace) {
			wf, ok := obj.(*wfv1.Workflow)
			if !ok || !selector.Matches(labels.Set(wf.Labels)) {
				continue
			}
			if f.NamePattern != "" && !strings.Contains(wf.Name, f.NamePattern) {
				continue
			}
			if len(phases) > 0 && !phases[workflowPhase(wf)] {
				continue
			}
			if !matchParams(wf, f.Parameters) {
				continue
			}
			if len(templates) > 0 && !templates[WorkflowSource(wf)] {
				continue
			}
			out = append(out, wf)
		}
	}
	sortNewest(out, func(w *wfv1.Workflow) metav1.Time { return w.CreationTimestamp })
	return out, nil
}

// workflowPhase treats a workflow with no phase yet as Pending, which is what the UI shows.
func workflowPhase(wf *wfv1.Workflow) string {
	if wf.Status.Phase != "" {
		return string(wf.Status.Phase)
	}
	if p := wf.Labels[common.LabelKeyPhase]; p != "" {
		return p
	}
	return string(wfv1.WorkflowPending)
}

// ListTemplates returns the WorkflowTemplates of a namespace (all namespaces when empty), newest first.
func (c *Cache) ListTemplates(ctx context.Context, namespace, labelSelector, namePattern string) ([]*wfv1.WorkflowTemplate, error) {
	if err := c.WaitSynced(ctx); err != nil {
		return nil, err
	}
	selector, err := parseSelector(labelSelector)
	if err != nil {
		return nil, err
	}
	var out []*wfv1.WorkflowTemplate
	for _, inf := range c.templates {
		for _, obj := range listNamespace(inf, namespace) {
			t, ok := obj.(*wfv1.WorkflowTemplate)
			if !ok || !selector.Matches(labels.Set(t.Labels)) || (namePattern != "" && !strings.Contains(t.Name, namePattern)) {
				continue
			}
			out = append(out, t)
		}
	}
	sortNewest(out, func(t *wfv1.WorkflowTemplate) metav1.Time { return t.CreationTimestamp })
	return out, nil
}

// GetTemplate looks a WorkflowTemplate up in the cache.
func (c *Cache) GetTemplate(namespace, name string) (*wfv1.WorkflowTemplate, bool) {
	for _, inf := range c.templates {
		if obj, ok, _ := inf.GetStore().GetByKey(namespace + "/" + name); ok {
			if t, ok := obj.(*wfv1.WorkflowTemplate); ok {
				return t, true
			}
		}
	}
	return nil, false
}

// ListClusterTemplates returns every ClusterWorkflowTemplate, newest first.
func (c *Cache) ListClusterTemplates(ctx context.Context, labelSelector, namePattern string) ([]*wfv1.ClusterWorkflowTemplate, error) {
	if err := c.WaitSynced(ctx); err != nil {
		return nil, err
	}
	selector, err := parseSelector(labelSelector)
	if err != nil {
		return nil, err
	}
	var out []*wfv1.ClusterWorkflowTemplate
	for _, obj := range c.clusterTpl.GetStore().List() {
		t, ok := obj.(*wfv1.ClusterWorkflowTemplate)
		if !ok || !selector.Matches(labels.Set(t.Labels)) || (namePattern != "" && !strings.Contains(t.Name, namePattern)) {
			continue
		}
		out = append(out, t)
	}
	sortNewest(out, func(t *wfv1.ClusterWorkflowTemplate) metav1.Time { return t.CreationTimestamp })
	return out, nil
}

// GetClusterTemplate looks a ClusterWorkflowTemplate up in the cache.
func (c *Cache) GetClusterTemplate(name string) (*wfv1.ClusterWorkflowTemplate, bool) {
	obj, ok, _ := c.clusterTpl.GetStore().GetByKey(name)
	if !ok {
		return nil, false
	}
	t, ok := obj.(*wfv1.ClusterWorkflowTemplate)
	return t, ok
}

// ListCrons returns the CronWorkflows of a namespace, newest first.
func (c *Cache) ListCrons(ctx context.Context, namespace, labelSelector, namePattern string) ([]*wfv1.CronWorkflow, error) {
	if err := c.WaitSynced(ctx); err != nil {
		return nil, err
	}
	selector, err := parseSelector(labelSelector)
	if err != nil {
		return nil, err
	}
	var out []*wfv1.CronWorkflow
	for _, inf := range c.crons {
		for _, obj := range listNamespace(inf, namespace) {
			cw, ok := obj.(*wfv1.CronWorkflow)
			if !ok || !selector.Matches(labels.Set(cw.Labels)) || (namePattern != "" && !strings.Contains(cw.Name, namePattern)) {
				continue
			}
			out = append(out, cw)
		}
	}
	sortNewest(out, func(c *wfv1.CronWorkflow) metav1.Time { return c.CreationTimestamp })
	return out, nil
}

func listNamespace(inf cache.SharedIndexInformer, namespace string) []any {
	if namespace == "" {
		return inf.GetStore().List()
	}
	objs, err := inf.GetIndexer().ByIndex(cache.NamespaceIndex, namespace)
	if err != nil {
		return nil
	}
	return objs
}

func parseSelector(s string) (labels.Selector, error) {
	if strings.TrimSpace(s) == "" {
		return labels.Everything(), nil
	}
	return labels.Parse(s)
}

func sortNewest[T any](items []T, createdAt func(T) metav1.Time) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := createdAt(items[i]), createdAt(items[j])
		if a.Equal(&b) {
			return false
		}
		return b.Before(&a)
	})
}

// ---- subscriptions ----

// SubscribeWorkflows calls fn for every workflow change in a namespace (all namespaces when empty)
// from now on. There is no initial replay: callers list first, then apply changes, which is what
// keeps a watch from re-sending the whole namespace every time it opens.
func (c *Cache) SubscribeWorkflows(namespace string, fn func(eventType string, wf *wfv1.Workflow)) func() {
	c.mu.Lock()
	id := c.nextID
	c.nextID++
	c.wfSubs[id] = workflowSub{namespace: namespace, fn: fn}
	c.mu.Unlock()
	return func() {
		c.mu.Lock()
		delete(c.wfSubs, id)
		c.mu.Unlock()
	}
}

// OnTemplateChange registers fn for every template change from now on, and first replays the
// templates already in the cache as initial adds. Without the replay a subscriber that attaches after
// the informers have started (every cluster switch, and a race at startup) would never see the
// templates that existed before it, since the informers announce those only once.
func (c *Cache) OnTemplateChange(fn func(TemplateChange)) {
	c.mu.Lock()
	c.tplSubs[c.nextID] = fn
	c.nextID++
	c.mu.Unlock()
	for _, inf := range c.templates {
		for _, obj := range inf.GetStore().List() {
			if t, ok := obj.(*wfv1.WorkflowTemplate); ok {
				fn(TemplateChange{Namespace: t.Namespace, Name: t.Name, Initial: true, Template: t})
			}
		}
	}
	for _, obj := range c.clusterTpl.GetStore().List() {
		if t, ok := obj.(*wfv1.ClusterWorkflowTemplate); ok {
			fn(TemplateChange{Cluster: true, Name: t.Name, Initial: true, ClusterTemplate: t})
		}
	}
}

func (c *Cache) dispatchWorkflow(eventType string, obj any) {
	if tomb, ok := obj.(cache.DeletedFinalStateUnknown); ok {
		obj = tomb.Obj
	}
	wf, ok := obj.(*wfv1.Workflow)
	if !ok {
		return
	}
	c.mu.RLock()
	subs := make([]workflowSub, 0, len(c.wfSubs))
	for _, s := range c.wfSubs {
		if s.namespace == "" || s.namespace == wf.Namespace {
			subs = append(subs, s)
		}
	}
	c.mu.RUnlock()
	for _, s := range subs {
		s.fn(eventType, wf)
	}
}

func (c *Cache) templateHandler(cluster bool) cache.ResourceEventHandler {
	emit := func(obj any, deleted, initial bool) {
		if tomb, ok := obj.(cache.DeletedFinalStateUnknown); ok {
			obj = tomb.Obj
		}
		change := TemplateChange{Cluster: cluster, Deleted: deleted, Initial: initial}
		switch t := obj.(type) {
		case *wfv1.WorkflowTemplate:
			change.Namespace, change.Name, change.Template = t.Namespace, t.Name, t
		case *wfv1.ClusterWorkflowTemplate:
			change.Name, change.ClusterTemplate = t.Name, t
		default:
			return
		}
		c.mu.RLock()
		fns := make([]func(TemplateChange), 0, len(c.tplSubs))
		for _, fn := range c.tplSubs {
			fns = append(fns, fn)
		}
		c.mu.RUnlock()
		for _, fn := range fns {
			fn(change)
		}
	}
	return cache.ResourceEventHandlerDetailedFuncs{
		AddFunc:    func(obj any, initial bool) { emit(obj, false, initial) },
		UpdateFunc: func(_, obj any) { emit(obj, false, false) },
		DeleteFunc: func(obj any) { emit(obj, true, false) },
	}
}

// ---- transforms ----

// runParameters is what a run was started with, for the list: the template's defaults (the stored
// template spec, which Argo merges with the submitted arguments) overridden by the workflow's own.
// Only names and values are kept; descriptions, enums and valueFrom are detail-page material.
func runParameters(wf *wfv1.Workflow) []wfv1.Parameter {
	var out []wfv1.Parameter
	index := map[string]int{}
	add := func(params []wfv1.Parameter) {
		for _, p := range params {
			light := wfv1.Parameter{Name: p.Name, Value: p.Value}
			if i, ok := index[p.Name]; ok {
				out[i] = light
				continue
			}
			index[p.Name] = len(out)
			out = append(out, light)
		}
	}
	if stored := wf.Status.StoredWorkflowSpec; stored != nil {
		add(stored.Arguments.Parameters)
	}
	add(wf.Spec.Arguments.Parameters)
	return out
}

// lightWorkflow keeps what list rows, filters and authorization read, and drops the rest — chiefly
// status.nodes and the stored template copies, which dominate a workflow's size.
func lightWorkflow(obj any) (any, error) {
	wf, ok := obj.(*wfv1.Workflow)
	if !ok {
		return obj, nil
	}
	meta := *wf.ObjectMeta.DeepCopy()
	meta.ManagedFields = nil
	delete(meta.Annotations, "kubectl.kubernetes.io/last-applied-configuration")
	light := &wfv1.Workflow{
		TypeMeta:   wf.TypeMeta,
		ObjectMeta: meta,
		Spec: wfv1.WorkflowSpec{
			WorkflowTemplateRef: wf.Spec.WorkflowTemplateRef.DeepCopy(),
			Entrypoint:          wf.Spec.Entrypoint,
			Suspend:             wf.Spec.Suspend,
			Shutdown:            wf.Spec.Shutdown,
			Arguments:           wfv1.Arguments{Parameters: runParameters(wf)},
		},
		Status: wfv1.WorkflowStatus{
			Phase:             wf.Status.Phase,
			StartedAt:         wf.Status.StartedAt,
			FinishedAt:        wf.Status.FinishedAt,
			EstimatedDuration: wf.Status.EstimatedDuration,
			Progress:          wf.Status.Progress,
			Message:           wf.Status.Message,
			ResourcesDuration: wf.Status.ResourcesDuration,
		},
	}
	// A suspended run is only recognisable from its nodes; keep that one bit as an annotation-free flag
	// by retaining just the running suspend nodes.
	for id, node := range wf.Status.Nodes {
		if node.Type == wfv1.NodeTypeSuspend && node.Phase == wfv1.NodeRunning {
			if light.Status.Nodes == nil {
				light.Status.Nodes = wfv1.Nodes{}
			}
			light.Status.Nodes[id] = wfv1.NodeStatus{ID: node.ID, Name: node.Name, DisplayName: node.DisplayName, Type: node.Type, Phase: node.Phase}
		}
	}
	return light, nil
}

func stripManagedFields(obj any) (any, error) {
	if m, ok := obj.(metav1.Object); ok {
		m.SetManagedFields(nil)
	}
	return obj, nil
}
