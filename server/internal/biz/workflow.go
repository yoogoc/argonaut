package biz

import (
	"context"
	"fmt"
	"io"
	"log/slog"

	"argonaut/internal/authz"
	pkgargo "argonaut/pkg/argo"

	stderrors "errors"
	workflowpkg "github.com/argoproj/argo-workflows/v4/pkg/apiclient/workflow"
	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"

	"github.com/go-kratos/kratos/v3/errors"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

// WorkflowUsecase authorizes workflow operations and delegates the work to Argo.
//
// Two rules shape every method here. First, a workflow's permissions are those of the template it
// came from, so anything but a list has to read the workflow before it can be authorized — the read
// happens with the platform ServiceAccount, but nothing is returned unless the check passes.
// Second, list results are filtered rather than refused: a user sees the subset they may see.
type WorkflowUsecase struct {
	log   *slog.Logger
	sw    *pkgargo.ClusterSwitch
	authz *AuthzUsecase
}

func NewWorkflowUsecase(sw *pkgargo.ClusterSwitch, authzUC *AuthzUsecase, logger *slog.Logger) *WorkflowUsecase {
	return &WorkflowUsecase{
		log:   logger.With("module", "biz/workflow"),
		sw:    sw,
		authz: authzUC,
	}
}

// servers and cache are the Argo servers and informer cache of the cluster the request was pinned to
// (pkgargo.ClusterSwitch), so one request never spans two clusters.
func (uc *WorkflowUsecase) servers(ctx context.Context) *pkgargo.Servers {
	return uc.sw.For(ctx).Servers
}

func (uc *WorkflowUsecase) cache(ctx context.Context) *pkgargo.Cache { return uc.sw.For(ctx).Cache }

// bindStream pins a long-lived stream to the current cluster and ends it if that cluster is switched
// away, so the client reconnects to the new one instead of watching a cluster nobody looks at.
func (uc *WorkflowUsecase) bindStream(ctx context.Context) (context.Context, context.CancelFunc) {
	ctx = uc.sw.Pin(ctx)
	return uc.sw.For(ctx).Bind(ctx)
}

// done audits a write that succeeded.
func (uc *WorkflowUsecase) done(ctx context.Context, action authz.Action, wf *wfv1.Workflow, detail any) {
	res := WorkflowResource(wf)
	uc.authz.Audit().Record(ctx, action, res, AuditAllowed, wf.Namespace+"/"+wf.Name, detail, uc.authz.Revision())
}

// argoContext decorates the context with the platform clients Argo's servers read from it, plus the
// caller identity Argo stamps onto resources it creates.
func (uc *WorkflowUsecase) argoContext(ctx context.Context) context.Context {
	ctx = pkgargo.WithClients(ctx, uc.servers(ctx).Clients)
	if subject := uc.authz.Subject(ctx); subject != "" {
		ctx = pkgargo.WithSubject(ctx, subject, "", "")
	}
	return ctx
}

// List returns the page of workflows the caller is allowed to see, served from the informer cache.
// Results are filtered per item rather than gated on a namespace-wide grant, so a user granted one
// template sees exactly its runs.
func (uc *WorkflowUsecase) List(ctx context.Context, opts pkgargo.ListOptions) (*wfv1.WorkflowList, error) {
	if err := uc.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	paramFilters, err := pkgargo.ParseParamFilters(opts.Parameters)
	if err != nil {
		return nil, errors.BadRequest("invalid_argument", err.Error())
	}
	all, err := uc.cache(ctx).ListWorkflows(ctx, pkgargo.WorkflowFilter{
		Namespace:     uc.servers(ctx).NamespaceFor(opts.Namespace),
		LabelSelector: opts.LabelSelector,
		NamePattern:   opts.NamePattern,
		Phases:        opts.Phases,
		Parameters:    paramFilters,
		Templates:     opts.Templates,
	})
	if err != nil {
		return nil, err
	}
	items := make([]wfv1.Workflow, 0, len(all))
	for _, wf := range all {
		if uc.authz.Allow(ctx, authz.WorkflowList, WorkflowResource(wf)) {
			items = append(items, *wf)
		}
	}
	// Paginate after filtering, not before: a page sliced first and filtered second would come back
	// short — or empty — for a user who may see only some of the namespace.
	window, next, remaining := pkgargo.Page(items, opts.ContinueToken, opts.Limit)
	list := &wfv1.WorkflowList{Items: window}
	list.Continue = next
	list.RemainingItemCount = &remaining
	return list, nil
}

// Get fetches a workflow, hydrating offloaded node status through Argo.
func (uc *WorkflowUsecase) Get(ctx context.Context, namespace, name, fields string) (*wfv1.Workflow, error) {
	wf, err := uc.fetch(ctx, namespace, name, fields)
	if err != nil {
		return nil, err
	}
	if err := uc.authz.Require(ctx, authz.WorkflowGet, WorkflowResource(wf)); err != nil {
		return nil, err
	}
	return wf, nil
}

// fetch reads a workflow without authorizing, for callers that authorize afterwards.
func (uc *WorkflowUsecase) fetch(ctx context.Context, namespace, name, fields string) (*wfv1.Workflow, error) {
	return uc.servers(ctx).Workflow.GetWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowGetRequest{
		Name:      name,
		Namespace: uc.servers(ctx).NamespaceFor(namespace),
		Fields:    fields,
	})
}

// authorizeOn reads the workflow and checks one action against its template scope.
func (uc *WorkflowUsecase) authorizeOn(ctx context.Context, namespace, name string, action authz.Action) (*wfv1.Workflow, error) {
	// Only metadata is needed to attribute the workflow, so node status is excluded: on a large
	// workflow that status is megabytes, and fetching it just to run a permission check is waste.
	wf, err := uc.fetch(ctx, namespace, name, "-status.nodes")
	if err != nil {
		return nil, err
	}
	if err := uc.authz.Require(ctx, action, WorkflowResource(wf)); err != nil {
		return nil, err
	}
	return wf, nil
}

// Watch streams workflow updates.
//
// A namespace watch (the list page) is fed by the informer cache: it sends only changes, never the
// whole namespace again, and every event is authorized for this caller. When the authorization
// revision changes mid-stream, everything already sent is re-checked, and runs the caller may no
// longer see are sent as DELETED (DESIGN §4.3).
//
// A watch on one workflow (the detail page) goes through Argo, because it needs the full object with
// node status — hydrated from the offload database when the controller offloads it.
func (uc *WorkflowUsecase) Watch(ctx context.Context, namespace, name, labelSelector, fields string, send func(*workflowpkg.WorkflowWatchEvent) error) error {
	ctx, stop := uc.bindStream(ctx)
	defer stop()
	if err := uc.authz.RequireAuthenticated(ctx); err != nil {
		return err
	}
	ns := uc.servers(ctx).NamespaceFor(namespace)
	if name != "" {
		return uc.watchOne(ctx, ns, name, fields, send)
	}
	selector, err := labels.Parse(labelSelector)
	if err != nil {
		return errors.BadRequest("invalid_argument", err.Error())
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	events := make(chan *workflowpkg.WorkflowWatchEvent, 256)
	sent := map[string]*wfv1.Workflow{}
	push := func(ev *workflowpkg.WorkflowWatchEvent) {
		select {
		case events <- ev:
		default:
			// The client cannot keep up; end the stream so it reconnects and re-lists rather than
			// silently missing events.
			cancel()
		}
	}
	unsubscribe := uc.cache(ctx).SubscribeWorkflows(ns, func(eventType string, wf *wfv1.Workflow) {
		if !selector.Matches(labels.Set(wf.Labels)) {
			return
		}
		push(&workflowpkg.WorkflowWatchEvent{Type: eventType, Object: wf})
	})
	defer unsubscribe()
	revisions := make(chan int64, 1)
	unsubscribeAuthz := uc.authz.Subscribe(func(rev int64) {
		select {
		case revisions <- rev:
		default:
		}
	})
	defer unsubscribeAuthz()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-revisions:
			for key, wf := range sent {
				if !uc.authz.Allow(ctx, authz.WorkflowGet, WorkflowResource(wf)) {
					delete(sent, key)
					if err := send(&workflowpkg.WorkflowWatchEvent{Type: "DELETED", Object: wf}); err != nil {
						return err
					}
				}
			}
		case ev := <-events:
			key := ev.Object.Namespace + "/" + ev.Object.Name
			if !uc.authz.Allow(ctx, authz.WorkflowGet, WorkflowResource(ev.Object)) {
				// It may have been visible a moment ago (its labels can change); retract it.
				if prev, ok := sent[key]; ok {
					delete(sent, key)
					if err := send(&workflowpkg.WorkflowWatchEvent{Type: "DELETED", Object: prev}); err != nil {
						return err
					}
				}
				continue
			}
			if ev.Type == "DELETED" {
				delete(sent, key)
			} else {
				sent[key] = ev.Object
			}
			if err := send(ev); err != nil {
				return err
			}
		}
	}
}

// watchOne streams one workflow in full. It ends when the caller loses access to it.
func (uc *WorkflowUsecase) watchOne(ctx context.Context, namespace, name, fields string, send func(*workflowpkg.WorkflowWatchEvent) error) error {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowGet)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	res := WorkflowResource(wf)
	unsubscribe := uc.authz.Subscribe(func(int64) {
		if !uc.authz.Allow(ctx, authz.WorkflowGet, res) {
			cancel()
		}
	})
	defer unsubscribe()

	req := &workflowpkg.WatchWorkflowsRequest{
		Namespace:   namespace,
		ListOptions: &metav1.ListOptions{FieldSelector: "metadata.name=" + name},
		Fields:      fields,
	}
	// Argo reads its clients from the stream's context, so the stream — not just this call — has to
	// carry the decorated context.
	stream := pkgargo.NewWatchStream(uc.argoContext(ctx), func(event *workflowpkg.WorkflowWatchEvent) error {
		if event.Object != nil && !uc.authz.Allow(ctx, authz.WorkflowGet, WorkflowResource(event.Object)) {
			cancel()
			return nil
		}
		return send(event)
	})
	err = uc.servers(ctx).Workflow.WatchWorkflows(req, stream)
	if ctx.Err() != nil && !uc.authz.Allow(context.WithoutCancel(ctx), authz.WorkflowGet, res) {
		return errors.Forbidden("forbidden", "your access to this workflow was revoked")
	}
	return err
}

// Events streams the Kubernetes events of one workflow.
func (uc *WorkflowUsecase) Events(ctx context.Context, namespace, name string, send func(*corev1.Event) error) error {
	ctx, stop := uc.bindStream(ctx)
	defer stop()
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowEvents)
	if err != nil {
		return err
	}
	req := &workflowpkg.WatchEventsRequest{
		Namespace: wf.Namespace,
		ListOptions: &metav1.ListOptions{
			FieldSelector: "involvedObject.name=" + wf.Name + ",involvedObject.namespace=" + wf.Namespace,
		},
	}
	return uc.servers(ctx).Workflow.WatchEvents(req, pkgargo.NewEventStream(uc.argoContext(ctx), send))
}

// Logs streams container logs, from the live pods while they exist and from the stored log artifacts
// once they are gone.
//
// The fallback is not an optimisation: Argo lists a workflow's pods to find logs, so after pod garbage
// collection it streams nothing at all and reports no error, which reads as "this run produced no
// output". nodeID identifies which node's stored logs to read, and is required for the fallback to
// address a single step.
func (uc *WorkflowUsecase) Logs(ctx context.Context, namespace, name, nodeID string, req *workflowpkg.WorkflowLogRequest, send func(*workflowpkg.LogEntry) error) error {
	ctx, stop := uc.bindStream(ctx)
	defer stop()
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowLogs)
	if err != nil {
		return err
	}
	req.Name = wf.Name
	req.Namespace = wf.Namespace
	argoCtx := uc.argoContext(ctx)

	live, err := uc.servers(ctx).LogsAvailableLive(argoCtx, wf.Namespace, wf.Name, req.PodName)
	if err != nil {
		return err
	}
	if live {
		stream := pkgargo.NewLogStream(argoCtx, send)
		// PodLogs targets one pod; WorkflowLogs fans out across every pod of the workflow.
		if req.PodName != "" {
			return uc.servers(ctx).Workflow.PodLogs(req, stream)
		}
		return uc.servers(ctx).Workflow.WorkflowLogs(req, stream)
	}

	// Artifact locations live on the node status, which authorizeOn deliberately did not fetch.
	full, err := uc.fetch(ctx, namespace, name, "")
	if err != nil {
		return err
	}
	err = uc.servers(ctx).StreamArchivedLogs(argoCtx, full, nodeID, req.Grep, func(line pkgargo.ArchivedLogLine) error {
		return send(&workflowpkg.LogEntry{Content: line.Content, PodName: line.PodName})
	})
	if stderrors.Is(err, pkgargo.ErrNoArchivedLogs) {
		// Say why the view is empty. Silence here is what made this look like a bug.
		return send(&workflowpkg.LogEntry{
			Content: "This step's pod has been deleted and no archived logs remain for it.",
			PodName: nodeID,
		})
	}
	return err
}

// Submit creates a workflow from a WorkflowTemplate, ClusterWorkflowTemplate or CronWorkflow.
func (uc *WorkflowUsecase) Submit(ctx context.Context, namespace, resourceKind, resourceName string, opts *wfv1.SubmitOpts) (*wfv1.Workflow, error) {
	ns := uc.servers(ctx).NamespaceFor(namespace)
	switch resourceKind {
	case "WorkflowTemplate", "workflowtemplate":
		if err := uc.authz.Require(ctx, authz.WorkflowSubmit, TemplateResource(ns, resourceName)); err != nil {
			return nil, err
		}
	case "ClusterWorkflowTemplate", "clusterworkflowtemplate":
		// The run will belong to the namespace, so the namespace decides whether it may run there;
		// the cluster template only has to be readable (DESIGN §4.4).
		if err := uc.authz.Require(ctx, authz.WorkflowSubmit, NamespaceResource(ns)); err != nil {
			return nil, err
		}
		if err := uc.authz.Require(ctx, authz.TemplateGet, ClusterTemplateResource(resourceName)); err != nil {
			return nil, err
		}
	case "CronWorkflow", "cronworkflow":
		cron, err := uc.servers(ctx).GetCronWorkflow(uc.argoContext(ctx), ns, resourceName)
		if err != nil {
			return nil, err
		}
		if err := uc.authz.Require(ctx, authz.WorkflowSubmit, CronWorkflowResource(cron)); err != nil {
			return nil, err
		}
	default:
		return nil, errors.BadRequest("invalid_argument",
			fmt.Sprintf("unsupported submit source %q; expected WorkflowTemplate, ClusterWorkflowTemplate or CronWorkflow", resourceKind))
	}
	wf, err := uc.servers(ctx).Workflow.SubmitWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowSubmitRequest{
		Namespace:     ns,
		ResourceKind:  resourceKind,
		ResourceName:  resourceName,
		SubmitOptions: opts,
	})
	if err != nil {
		return nil, err
	}
	uc.done(ctx, authz.WorkflowSubmit, wf, map[string]any{"source": resourceKind + "/" + resourceName, "parameters": submitParams(opts)})
	return wf, nil
}

func submitParams(opts *wfv1.SubmitOpts) []string {
	if opts == nil {
		return nil
	}
	return opts.Parameters
}

// Create submits a raw manifest. There is no template to inherit from, so it needs a namespace-wide
// grant — otherwise a single-template grant would be a way to run arbitrary workloads.
func (uc *WorkflowUsecase) Create(ctx context.Context, namespace string, wf *wfv1.Workflow, dryRun bool) (*wfv1.Workflow, error) {
	ns := uc.servers(ctx).NamespaceFor(namespace)
	if err := uc.authz.Require(ctx, authz.WorkflowSubmit, NamespaceResource(ns)); err != nil {
		return nil, err
	}
	sanitizeLineage(wf)
	req := &workflowpkg.WorkflowCreateRequest{Namespace: ns, Workflow: wf}
	if dryRun {
		req.CreateOptions = &metav1.CreateOptions{DryRun: []string{"All"}}
	}
	created, err := uc.servers(ctx).Workflow.CreateWorkflow(uc.argoContext(ctx), req)
	if err == nil && !dryRun {
		uc.done(ctx, authz.WorkflowSubmit, created, map[string]any{"source": "manifest"})
	}
	return created, err
}

// Lint validates a manifest without creating anything.
func (uc *WorkflowUsecase) Lint(ctx context.Context, namespace string, wf *wfv1.Workflow) (*wfv1.Workflow, error) {
	ns := uc.servers(ctx).NamespaceFor(namespace)
	if err := uc.authz.Require(ctx, authz.WorkflowSubmit, NamespaceResource(ns)); err != nil {
		return nil, err
	}
	return uc.servers(ctx).Workflow.LintWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowLintRequest{Namespace: ns, Workflow: wf})
}

func (uc *WorkflowUsecase) Retry(ctx context.Context, namespace, name string, restartSuccessful bool, nodeFieldSelector string, parameters []string) (*wfv1.Workflow, error) {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowRetry)
	if err != nil {
		return nil, err
	}
	out, err := uc.servers(ctx).Workflow.RetryWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowRetryRequest{
		Name:              wf.Name,
		Namespace:         wf.Namespace,
		RestartSuccessful: restartSuccessful,
		NodeFieldSelector: nodeFieldSelector,
		Parameters:        parameters,
	})
	if err == nil {
		uc.done(ctx, authz.WorkflowRetry, wf, nil)
	}
	return out, err
}

func (uc *WorkflowUsecase) Resubmit(ctx context.Context, namespace, name string, memoized bool, parameters []string) (*wfv1.Workflow, error) {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowResubmit)
	if err != nil {
		return nil, err
	}
	out, err := uc.servers(ctx).Workflow.ResubmitWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowResubmitRequest{
		Name:       wf.Name,
		Namespace:  wf.Namespace,
		Memoized:   memoized,
		Parameters: parameters,
	})
	if err == nil {
		uc.done(ctx, authz.WorkflowResubmit, wf, nil)
	}
	return out, err
}

func (uc *WorkflowUsecase) Suspend(ctx context.Context, namespace, name string) (*wfv1.Workflow, error) {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowSuspend)
	if err != nil {
		return nil, err
	}
	out, err := uc.servers(ctx).Workflow.SuspendWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowSuspendRequest{
		Name:      wf.Name,
		Namespace: wf.Namespace,
	})
	if err == nil {
		uc.done(ctx, authz.WorkflowSuspend, wf, nil)
	}
	return out, err
}

func (uc *WorkflowUsecase) Resume(ctx context.Context, namespace, name, nodeFieldSelector string) (*wfv1.Workflow, error) {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowResume)
	if err != nil {
		return nil, err
	}
	out, err := uc.servers(ctx).Workflow.ResumeWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowResumeRequest{
		Name:              wf.Name,
		Namespace:         wf.Namespace,
		NodeFieldSelector: nodeFieldSelector,
	})
	if err == nil {
		uc.done(ctx, authz.WorkflowResume, wf, nil)
	}
	return out, err
}

// Set writes node output parameters or phase; the UI uses it to fill a suspend node's inputs before
// resuming.
func (uc *WorkflowUsecase) Set(ctx context.Context, namespace, name, nodeFieldSelector, outputParameters, phase, message string) (*wfv1.Workflow, error) {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowSet)
	if err != nil {
		return nil, err
	}
	out, err := uc.servers(ctx).Workflow.SetWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowSetRequest{
		Name:              wf.Name,
		Namespace:         wf.Namespace,
		NodeFieldSelector: nodeFieldSelector,
		OutputParameters:  outputParameters,
		Phase:             phase,
		Message:           message,
	})
	if err == nil {
		uc.done(ctx, authz.WorkflowSet, wf, nil)
	}
	return out, err
}

func (uc *WorkflowUsecase) Stop(ctx context.Context, namespace, name, nodeFieldSelector, message string) (*wfv1.Workflow, error) {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowStop)
	if err != nil {
		return nil, err
	}
	out, err := uc.servers(ctx).Workflow.StopWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowStopRequest{
		Name:              wf.Name,
		Namespace:         wf.Namespace,
		NodeFieldSelector: nodeFieldSelector,
		Message:           message,
	})
	if err == nil {
		uc.done(ctx, authz.WorkflowStop, wf, nil)
	}
	return out, err
}

func (uc *WorkflowUsecase) Terminate(ctx context.Context, namespace, name string) (*wfv1.Workflow, error) {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowTerminate)
	if err != nil {
		return nil, err
	}
	out, err := uc.servers(ctx).Workflow.TerminateWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowTerminateRequest{
		Name:      wf.Name,
		Namespace: wf.Namespace,
	})
	if err == nil {
		uc.done(ctx, authz.WorkflowTerminate, wf, nil)
	}
	return out, err
}

func (uc *WorkflowUsecase) Delete(ctx context.Context, namespace, name string, force bool) error {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowDelete)
	if err != nil {
		return err
	}
	_, err = uc.servers(ctx).Workflow.DeleteWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowDeleteRequest{
		Name:      wf.Name,
		Namespace: wf.Namespace,
		Force:     force,
	})
	if err == nil {
		uc.done(ctx, authz.WorkflowDelete, wf, nil)
	}
	return err
}

// OpenArtifact authorizes and opens a node artifact for streaming.
func (uc *WorkflowUsecase) OpenArtifact(ctx context.Context, namespace, name, nodeID, artifactName string, isInput bool) (*wfv1.Artifact, io.ReadCloser, error) {
	// The full node status is required here: the artifact's location lives on the node.
	wf, err := uc.fetch(ctx, namespace, name, "")
	if err != nil {
		return nil, nil, err
	}
	if err := uc.authz.Require(ctx, authz.WorkflowArtifacts, WorkflowResource(wf)); err != nil {
		return nil, nil, err
	}
	art, reader, err := uc.servers(ctx).Artifacts.Open(uc.argoContext(ctx), wf, nodeID, artifactName, isInput)
	if err != nil {
		return nil, nil, err
	}
	return art, reader, nil
}

func isForbidden(err error) bool {
	return errors.Code(err) == 403
}
