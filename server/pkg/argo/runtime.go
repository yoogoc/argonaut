package argo

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"argonaut/internal/conf"

	"google.golang.org/protobuf/proto"
	"k8s.io/client-go/tools/clientcmd"
)

const (
	// switchSyncTimeout bounds how long a switch waits for the new cluster's cache before giving up
	// and staying on the current cluster.
	switchSyncTimeout = 30 * time.Second
	// retireDelay lets requests that started on the previous cluster finish before its informers stop.
	retireDelay = 10 * time.Second
)

// Runtime is everything argonaut holds for one cluster: its clients, Argo's server implementations
// and the informer cache. A request uses exactly one Runtime from start to finish (see
// ClusterSwitch.For).
type Runtime struct {
	ID      string
	Name    string
	Env     string
	Kube    *conf.Kube
	Clients *Clients
	Servers *Servers
	Cache   *Cache

	done chan struct{}
	stop func()
}

// Done is closed when this runtime is replaced by a switch. Long-lived streams end then, so clients
// reconnect to the new cluster.
func (r *Runtime) Done() <-chan struct{} { return r.done }

// Bind returns a context that is also cancelled when the runtime is retired.
func (r *Runtime) Bind(ctx context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(ctx)
	go func() {
		select {
		case <-r.done:
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}

func newRuntime(ctx context.Context, c ClusterChoice, logger *slog.Logger) (*Runtime, error) {
	clients, err := NewClients(c.Kube, logger)
	if err != nil {
		return nil, err
	}
	servers, stopServers, err := NewServers(ctx, clients, c.Argo, logger)
	if err != nil {
		return nil, err
	}
	cache, stopCache, err := NewCache(clients, servers, c.Kube, logger)
	if err != nil {
		stopServers()
		return nil, err
	}
	return &Runtime{
		ID: c.ID, Name: c.Name, Env: c.Env, Kube: c.Kube,
		Clients: clients, Servers: servers, Cache: cache,
		done: make(chan struct{}),
		stop: func() { stopCache(); stopServers() },
	}, nil
}

// ClusterChoice is one cluster the instance can be switched to, with the top-level kube and argo
// settings already merged under its own.
type ClusterChoice struct {
	ID   string
	Name string
	Env  string
	Kube *conf.Kube
	Argo *conf.Argo
}

// ClusterStatus describes a choice for the UI.
type ClusterStatus struct {
	ClusterChoice
	Current   bool
	Switching bool
	LastError string
}

// ClusterSwitch holds the runtime of the cluster the instance is connected to. With cluster_switch
// disabled it holds the single cluster of the top-level config and never changes; enabled, an
// administrator can switch it to another configured cluster (docs/multi-cluster.md).
type ClusterSwitch struct {
	log     *slog.Logger
	ctx     context.Context
	enabled bool
	// The configuration choices are resolved from; with from_kubeconfig they are re-resolved on use,
	// so contexts added to the kubeconfig appear without a restart.
	kube *conf.Kube
	argo *conf.Argo
	conf *conf.ClusterSwitch

	current atomic.Pointer[Runtime]

	// switchMu serialises switches, which can take as long as a cluster takes to load; mu guards the
	// fields below for short reads, so listing clusters never waits on a switch in progress.
	switchMu  sync.Mutex
	mu        sync.Mutex
	switching string
	lastErr   map[string]string
	subs      []func(*Runtime)
	// choices is the last successful resolution, kept for when the kubeconfig cannot be read.
	choices []ClusterChoice
}

type runtimeKey struct{}

// NewClusterSwitch connects to the configured (or, with switching enabled, the default) cluster.
func NewClusterSwitch(ctx context.Context, kube *conf.Kube, argo *conf.Argo, sw *conf.ClusterSwitch, logger *slog.Logger) (*ClusterSwitch, func(), error) {
	s := &ClusterSwitch{log: logger.With("module", "argo/switch"), ctx: ctx, lastErr: map[string]string{}, kube: kube, argo: argo, conf: sw}
	initial := ClusterChoice{Kube: kube, Argo: argo}
	if sw.GetEnabled() {
		choices, current, err := Choices(kube, argo, sw)
		if err != nil {
			return nil, nil, err
		}
		s.enabled, s.choices = true, choices
		initial = pickInitial(choices, sw.GetDefault(), kube.GetContext(), current)
	}
	rt, err := newRuntime(ctx, initial, logger)
	if err != nil {
		if s.enabled {
			return nil, nil, fmt.Errorf("connecting to cluster %q: %w", initial.ID, err)
		}
		return nil, nil, err
	}
	s.current.Store(rt)
	if s.enabled {
		s.log.Info("cluster switching enabled", "current", rt.ID, "clusters", len(s.choices), "fromKubeconfig", sw.GetFromKubeconfig())
	}
	return s, func() { s.Current().stop() }, nil
}

// pickInitial chooses the cluster to connect at startup: the configured default, then the pinned
// kube.context, then the kubeconfig's current-context, then the first choice.
func pickInitial(choices []ClusterChoice, preferred ...string) ClusterChoice {
	for _, id := range preferred {
		for _, c := range choices {
			if id != "" && c.ID == id {
				return c
			}
		}
	}
	return choices[0]
}

// loadKubeconfig reads the context names and current-context of the kubeconfig the clients use. A
// variable so tests can supply a kubeconfig.
var loadKubeconfig = func(kube *conf.Kube) ([]string, string, error) {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	if path := kube.GetKubeconfig(); path != "" {
		rules.ExplicitPath = path
	}
	raw, err := rules.Load()
	if err != nil {
		return nil, "", fmt.Errorf("reading kubeconfig: %w", err)
	}
	names := make([]string, 0, len(raw.Contexts))
	for name := range raw.Contexts {
		names = append(names, name)
	}
	sort.Strings(names)
	return names, raw.CurrentContext, nil
}

var (
	eksContext = regexp.MustCompile(`^arn:aws:eks:[^:]+:\d+:cluster/(.+)$`)
	words      = regexp.MustCompile(`[a-z0-9]+`)
)

// contextName shortens a kubeconfig context for display: an EKS context is an ARN whose last part is
// the cluster's own name.
func contextName(context string) string {
	if m := eksContext.FindStringSubmatch(context); m != nil {
		return m[1]
	}
	return context
}

// contextEnv guesses an environment from a context name, so production clusters are marked without
// configuration: "aliyun-prod", "web-prod-cluster", "prd-..." are prod; "uat", "staging" are uat.
func contextEnv(context string) string {
	name := strings.ToLower(contextName(context))
	for _, word := range words.FindAllString(name, -1) {
		switch word {
		case "prod", "production", "prd":
			return "prod"
		}
	}
	if strings.Contains(name, "uat") || strings.Contains(name, "staging") || strings.Contains(name, "stage") {
		return "uat"
	}
	return ""
}

// Choices resolves the clusters the instance can switch between, each merged over the top-level kube
// and argo sections, and returns the kubeconfig's current-context when the list came from it.
func Choices(kube *conf.Kube, argo *conf.Argo, sw *conf.ClusterSwitch) ([]ClusterChoice, string, error) {
	overrides := map[string]*conf.ClusterSwitch_Cluster{}
	for _, c := range sw.GetClusters() {
		if c.GetId() == "" {
			return nil, "", fmt.Errorf("cluster_switch: every cluster needs an id")
		}
		if overrides[c.GetId()] != nil {
			return nil, "", fmt.Errorf("cluster_switch: cluster id %q is listed twice", c.GetId())
		}
		overrides[c.GetId()] = c
	}
	var out []ClusterChoice
	seen := map[string]bool{}
	current := ""
	if sw.GetFromKubeconfig() {
		names, cur, err := loadKubeconfig(kube)
		if err != nil {
			return nil, "", err
		}
		current = cur
		for _, ctxName := range names {
			c := ClusterChoice{ID: ctxName, Name: contextName(ctxName), Env: contextEnv(ctxName),
				Kube: mergeKube(kube, &conf.Kube{Context: ctxName}), Argo: mergeArgo(argo, nil)}
			if o := overrides[ctxName]; o != nil {
				if o.GetName() != "" {
					c.Name = o.GetName()
				}
				if o.GetEnv() != "" {
					c.Env = o.GetEnv()
				}
				c.Kube, c.Argo = mergeKube(c.Kube, o.GetKube()), mergeArgo(c.Argo, o.GetArgo())
			}
			seen[ctxName] = true
			out = append(out, c)
		}
	}
	for _, c := range sw.GetClusters() {
		if seen[c.GetId()] {
			continue
		}
		seen[c.GetId()] = true
		name := c.GetName()
		if name == "" {
			name = c.GetId()
		}
		out = append(out, ClusterChoice{ID: c.GetId(), Name: name, Env: c.GetEnv(), Kube: mergeKube(kube, c.GetKube()), Argo: mergeArgo(argo, c.GetArgo())})
	}
	if len(out) == 0 {
		if sw.GetFromKubeconfig() {
			return nil, "", fmt.Errorf("cluster_switch: the kubeconfig has no contexts")
		}
		return nil, "", fmt.Errorf("cluster_switch is enabled but lists no clusters (set from_kubeconfig to offer the kubeconfig's contexts)")
	}
	if d := sw.GetDefault(); d != "" && !seen[d] {
		return nil, "", fmt.Errorf("cluster_switch: default %q is not one of the clusters", d)
	}
	return out, current, nil
}

// currentChoices re-resolves the choices when they come from the kubeconfig, falling back to the last
// good list if it cannot be read right now.
func (s *ClusterSwitch) currentChoices() []ClusterChoice {
	if s.conf.GetFromKubeconfig() {
		choices, _, err := Choices(s.kube, s.argo, s.conf)
		if err == nil {
			s.mu.Lock()
			s.choices = choices
			s.mu.Unlock()
			return choices
		}
		s.log.Warn("re-reading the kubeconfig failed; offering the previous cluster list", "err", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.choices
}

func mergeKube(base, over *conf.Kube) *conf.Kube {
	out := &conf.Kube{}
	if base != nil {
		out = proto.Clone(base).(*conf.Kube)
	}
	if over == nil {
		return out
	}
	// proto.Merge appends repeated fields; a cluster's namespaces replace the top-level ones.
	if len(over.GetNamespaces()) > 0 {
		out.Namespaces = nil
	}
	proto.Merge(out, over)
	return out
}

func mergeArgo(base, over *conf.Argo) *conf.Argo {
	out := &conf.Argo{}
	if base != nil {
		out = proto.Clone(base).(*conf.Argo)
	}
	if over != nil {
		proto.Merge(out, over)
	}
	return out
}

// Enabled reports whether the instance may be switched between clusters.
func (s *ClusterSwitch) Enabled() bool { return s.enabled }

// Current is the runtime new requests start on.
func (s *ClusterSwitch) Current() *Runtime { return s.current.Load() }

// Pin fixes the current runtime for the rest of a request.
func (s *ClusterSwitch) Pin(ctx context.Context) context.Context {
	if _, ok := ctx.Value(runtimeKey{}).(*Runtime); ok {
		return ctx
	}
	return context.WithValue(ctx, runtimeKey{}, s.Current())
}

// For returns the runtime a request was pinned to, or the current one for unpinned work.
func (s *ClusterSwitch) For(ctx context.Context) *Runtime {
	if rt, ok := ctx.Value(runtimeKey{}).(*Runtime); ok {
		return rt
	}
	return s.Current()
}

// Subscribe calls fn with the current runtime now and with every runtime switched to later, so
// components that follow a cluster's cache (template history, orphan grants) re-attach to it.
func (s *ClusterSwitch) Subscribe(fn func(*Runtime)) {
	s.mu.Lock()
	s.subs = append(s.subs, fn)
	s.mu.Unlock()
	fn(s.Current())
}

// Statuses lists the clusters the instance can be switched to.
func (s *ClusterSwitch) Statuses() []ClusterStatus {
	choices := s.currentChoices()
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.Current().ID
	out := make([]ClusterStatus, 0, len(choices))
	for _, c := range choices {
		out = append(out, ClusterStatus{ClusterChoice: c, Current: c.ID == current, Switching: c.ID == s.switching, LastError: s.lastErr[c.ID]})
	}
	return out
}

// ErrSwitchDisabled is returned by Switch when cluster_switch is off.
var ErrSwitchDisabled = fmt.Errorf("cluster switching is not enabled")

// Switch connects to another cluster and, once its cache has synced, makes it current. If the new
// cluster cannot be reached the instance stays where it is. Requests already running finish on the
// previous cluster; its streams end so their clients reconnect.
func (s *ClusterSwitch) Switch(ctx context.Context, id string) (*Runtime, error) {
	if !s.enabled {
		return nil, ErrSwitchDisabled
	}
	var choice *ClusterChoice
	choices := s.currentChoices()
	for i := range choices {
		if choices[i].ID == id {
			choice = &choices[i]
		}
	}
	if choice == nil {
		return nil, fmt.Errorf("unknown cluster %q", id)
	}
	s.switchMu.Lock()
	defer s.switchMu.Unlock()
	if cur := s.Current(); cur.ID == id {
		return cur, nil
	}
	s.setSwitching(id)
	defer s.setSwitching("")

	start := time.Now()
	rt, err := newRuntime(s.ctx, *choice, s.log)
	if err == nil {
		syncCtx, cancel := context.WithTimeout(ctx, switchSyncTimeout)
		err = rt.Cache.WaitSynced(syncCtx)
		cancel()
		if err != nil {
			rt.stop()
			err = fmt.Errorf("cluster %q did not finish loading within %s: %w", id, switchSyncTimeout, err)
		}
	}
	s.mu.Lock()
	if err != nil {
		s.lastErr[id] = err.Error()
	} else {
		delete(s.lastErr, id)
	}
	subs := append([]func(*Runtime){}, s.subs...)
	s.mu.Unlock()
	if err != nil {
		s.log.Warn("cluster switch failed; staying on the current cluster", "to", id, "err", err)
		return nil, err
	}
	old := s.current.Swap(rt)
	s.log.Info("switched cluster", "from", old.ID, "to", id, "took", time.Since(start).Round(time.Millisecond))
	for _, fn := range subs {
		fn(rt)
	}
	close(old.done)
	time.AfterFunc(retireDelay, old.stop)
	return rt, nil
}

func (s *ClusterSwitch) setSwitching(id string) {
	s.mu.Lock()
	s.switching = id
	s.mu.Unlock()
}

// FixedSwitch wraps already-built parts in a ClusterSwitch that cannot be switched, for tests and
// tools that assemble a runtime by hand.
func FixedSwitch(clients *Clients, servers *Servers, cache *Cache) *ClusterSwitch {
	s := &ClusterSwitch{log: slog.Default(), ctx: context.Background(), lastErr: map[string]string{}}
	s.current.Store(&Runtime{Kube: &conf.Kube{}, Clients: clients, Servers: servers, Cache: cache, done: make(chan struct{}), stop: func() {}})
	return s
}
