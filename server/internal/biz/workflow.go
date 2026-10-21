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
)

// WorkflowUsecase authorizes workflow operations and delegates the work to Argo.
//
// Two rules shape every method here. First, a workflow's permissions are those of the template it
// came from, so anything but a list has to read the workflow before it can be authorized — the read
// happens with the platform ServiceAccount, but nothing is returned unless the check passes.
// Second, list results are filtered rather than refused: a user sees the subset they may see.
type WorkflowUsecase struct {
	log     *slog.Logger
	servers *pkgargo.Servers
	authz   *AuthzUsecase
}

func NewWorkflowUsecase(servers *pkgargo.Servers, authzUC *AuthzUsecase, logger *slog.Logger) *WorkflowUsecase {
	return &WorkflowUsecase{
		log:     logger.With("module", "biz/workflow"),
		servers: servers,
		authz:   authzUC,
	}
}

// argoContext decorates the context with the platform clients Argo's servers read from it, plus the
// caller identity Argo stamps onto resources it creates.
func (uc *WorkflowUsecase) argoContext(ctx context.Context) context.Context {
	ctx = pkgargo.WithClients(ctx, uc.servers.Clients)
	if subject := uc.authz.Subject(ctx); subject != "" {
		ctx = pkgargo.WithSubject(ctx, subject, "", "")
	}
	return ctx
}

// List returns the page of workflows the caller is allowed to see. Results are filtered per item
// rather than gated on a namespace-wide grant, so a user granted one template sees exactly its runs.
func (uc *WorkflowUsecase) List(ctx context.Context, opts pkgargo.ListOptions) (*wfv1.WorkflowList, error) {
	if err := uc.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}

	list, err := uc.servers.ListWorkflows(uc.argoContext(ctx), opts)
	if err != nil {
		return nil, err
	}

	items := make([]wfv1.Workflow, 0, len(list.Items))
	for i := range list.Items {
		if uc.authz.Allow(ctx, authz.WorkflowList, WorkflowResource(&list.Items[i])) {
			items = append(items, list.Items[i])
		}
	}

	// Paginate after filtering, not before: a page sliced first and filtered second would come back
	// short — or empty — for a user who may see only some of the namespace.
	window, next, remaining := pkgargo.Page(items, opts.ContinueToken, opts.Limit)
	list.Items = window
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
	return uc.servers.Workflow.GetWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowGetRequest{
		Name:      name,
		Namespace: uc.servers.NamespaceFor(namespace),
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

// Watch streams workflow updates. Each event is authorized individually, because a namespace watch
// sees workflows from templates the caller may have no grant on.
func (uc *WorkflowUsecase) Watch(ctx context.Context, namespace, name, labelSelector, fields string, send func(*workflowpkg.WorkflowWatchEvent) error) error {
	fieldSelector := ""
	if name != "" {
		fieldSelector = "metadata.name=" + name
	}
	req := &workflowpkg.WatchWorkflowsRequest{
		Namespace: uc.servers.NamespaceFor(namespace),
		ListOptions: &metav1.ListOptions{
			LabelSelector: labelSelector,
			FieldSelector: fieldSelector,
		},
		Fields: fields,
	}

	// Argo reads its clients from the stream's context, so the stream — not just this call — has to
	// carry the decorated context.
	stream := pkgargo.NewWatchStream(uc.argoContext(ctx), func(event *workflowpkg.WorkflowWatchEvent) error {
		// Skipping an event the caller may not see is deliberate: dropping one frame is invisible
		// to a live view, whereas failing the stream would break the whole page.
		if event.Object != nil && !uc.authz.Allow(ctx, authz.WorkflowGet, WorkflowResource(event.Object)) {
			return nil
		}
		return send(event)
	})
	return uc.servers.Workflow.WatchWorkflows(req, stream)
}

// Events streams the Kubernetes events of one workflow.
func (uc *WorkflowUsecase) Events(ctx context.Context, namespace, name string, send func(*corev1.Event) error) error {
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
	return uc.servers.Workflow.WatchEvents(req, pkgargo.NewEventStream(uc.argoContext(ctx), send))
}

// Logs streams container logs, from the live pods while they exist and from the stored log artifacts
// once they are gone.
//
// The fallback is not an optimisation: Argo lists a workflow's pods to find logs, so after pod garbage
// collection it streams nothing at all and reports no error, which reads as "this run produced no
// output". nodeID identifies which node's stored logs to read, and is required for the fallback to
// address a single step.
func (uc *WorkflowUsecase) Logs(ctx context.Context, namespace, name, nodeID string, req *workflowpkg.WorkflowLogRequest, send func(*workflowpkg.LogEntry) error) error {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowLogs)
	if err != nil {
		return err
	}
	req.Name = wf.Name
	req.Namespace = wf.Namespace
	argoCtx := uc.argoContext(ctx)

	live, err := uc.servers.LogsAvailableLive(argoCtx, wf.Namespace, wf.Name, req.PodName)
	if err != nil {
		return err
	}
	if live {
		stream := pkgargo.NewLogStream(argoCtx, send)
		// PodLogs targets one pod; WorkflowLogs fans out across every pod of the workflow.
		if req.PodName != "" {
			return uc.servers.Workflow.PodLogs(req, stream)
		}
		return uc.servers.Workflow.WorkflowLogs(req, stream)
	}

	// Artifact locations live on the node status, which authorizeOn deliberately did not fetch.
	full, err := uc.fetch(ctx, namespace, name, "")
	if err != nil {
		return err
	}
	err = uc.servers.StreamArchivedLogs(argoCtx, full, nodeID, req.Grep, func(line pkgargo.ArchivedLogLine) error {
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

// Submit creates a workflow from a template or cron workflow. The permission is checked against the
// source resource, which is exactly the scope grants are written against.
func (uc *WorkflowUsecase) Submit(ctx context.Context, namespace, resourceKind, resourceName string, opts *wfv1.SubmitOpts) (*wfv1.Workflow, error) {
	ns := uc.servers.NamespaceFor(namespace)
	res, err := uc.submitResource(ctx, ns, resourceKind, resourceName)
	if err != nil {
		return nil, err
	}
	if err := uc.authz.Require(ctx, authz.WorkflowSubmit, res); err != nil {
		return nil, err
	}
	return uc.servers.Workflow.SubmitWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowSubmitRequest{
		Namespace:     ns,
		ResourceKind:  resourceKind,
		ResourceName:  resourceName,
		SubmitOptions: opts,
	})
}

// submitResource maps the submit source onto the scope that governs it.
func (uc *WorkflowUsecase) submitResource(ctx context.Context, namespace, kind, name string) (authz.Resource, error) {
	switch kind {
	case "WorkflowTemplate", "workflowtemplate":
		return TemplateResource(namespace, name), nil
	case "CronWorkflow", "cronworkflow":
		cron, err := uc.servers.GetCronWorkflow(uc.argoContext(ctx), namespace, name)
		if err != nil {
			return authz.Resource{}, err
		}
		return CronWorkflowResource(cron), nil
	default:
		return authz.Resource{}, errors.BadRequest("invalid_argument",
			fmt.Sprintf("unsupported submit source %q; expected WorkflowTemplate or CronWorkflow", kind))
	}
}

// Create submits a raw manifest. There is no template to inherit from, so it needs a namespace-wide
// grant — otherwise a single-template grant would be a way to run arbitrary workloads.
func (uc *WorkflowUsecase) Create(ctx context.Context, namespace string, wf *wfv1.Workflow, dryRun bool) (*wfv1.Workflow, error) {
	ns := uc.servers.NamespaceFor(namespace)
	if err := uc.authz.Require(ctx, authz.WorkflowSubmit, NamespaceResource(ns)); err != nil {
		return nil, err
	}
	req := &workflowpkg.WorkflowCreateRequest{Namespace: ns, Workflow: wf}
	if dryRun {
		req.CreateOptions = &metav1.CreateOptions{DryRun: []string{"All"}}
	}
	return uc.servers.Workflow.CreateWorkflow(uc.argoContext(ctx), req)
}

// Lint validates a manifest without creating anything.
func (uc *WorkflowUsecase) Lint(ctx context.Context, namespace string, wf *wfv1.Workflow) (*wfv1.Workflow, error) {
	ns := uc.servers.NamespaceFor(namespace)
	if err := uc.authz.Require(ctx, authz.WorkflowSubmit, NamespaceResource(ns)); err != nil {
		return nil, err
	}
	return uc.servers.Workflow.LintWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowLintRequest{Namespace: ns, Workflow: wf})
}

func (uc *WorkflowUsecase) Retry(ctx context.Context, namespace, name string, restartSuccessful bool, nodeFieldSelector string, parameters []string) (*wfv1.Workflow, error) {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowRetry)
	if err != nil {
		return nil, err
	}
	return uc.servers.Workflow.RetryWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowRetryRequest{
		Name:              wf.Name,
		Namespace:         wf.Namespace,
		RestartSuccessful: restartSuccessful,
		NodeFieldSelector: nodeFieldSelector,
		Parameters:        parameters,
	})
}

func (uc *WorkflowUsecase) Resubmit(ctx context.Context, namespace, name string, memoized bool, parameters []string) (*wfv1.Workflow, error) {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowResubmit)
	if err != nil {
		return nil, err
	}
	return uc.servers.Workflow.ResubmitWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowResubmitRequest{
		Name:       wf.Name,
		Namespace:  wf.Namespace,
		Memoized:   memoized,
		Parameters: parameters,
	})
}

func (uc *WorkflowUsecase) Suspend(ctx context.Context, namespace, name string) (*wfv1.Workflow, error) {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowSuspend)
	if err != nil {
		return nil, err
	}
	return uc.servers.Workflow.SuspendWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowSuspendRequest{
		Name:      wf.Name,
		Namespace: wf.Namespace,
	})
}

func (uc *WorkflowUsecase) Resume(ctx context.Context, namespace, name, nodeFieldSelector string) (*wfv1.Workflow, error) {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowResume)
	if err != nil {
		return nil, err
	}
	return uc.servers.Workflow.ResumeWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowResumeRequest{
		Name:              wf.Name,
		Namespace:         wf.Namespace,
		NodeFieldSelector: nodeFieldSelector,
	})
}

// Set writes node output parameters or phase; the UI uses it to fill a suspend node's inputs before
// resuming.
func (uc *WorkflowUsecase) Set(ctx context.Context, namespace, name, nodeFieldSelector, outputParameters, phase, message string) (*wfv1.Workflow, error) {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowSet)
	if err != nil {
		return nil, err
	}
	return uc.servers.Workflow.SetWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowSetRequest{
		Name:              wf.Name,
		Namespace:         wf.Namespace,
		NodeFieldSelector: nodeFieldSelector,
		OutputParameters:  outputParameters,
		Phase:             phase,
		Message:           message,
	})
}

func (uc *WorkflowUsecase) Stop(ctx context.Context, namespace, name, nodeFieldSelector, message string) (*wfv1.Workflow, error) {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowStop)
	if err != nil {
		return nil, err
	}
	return uc.servers.Workflow.StopWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowStopRequest{
		Name:              wf.Name,
		Namespace:         wf.Namespace,
		NodeFieldSelector: nodeFieldSelector,
		Message:           message,
	})
}

func (uc *WorkflowUsecase) Terminate(ctx context.Context, namespace, name string) (*wfv1.Workflow, error) {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowTerminate)
	if err != nil {
		return nil, err
	}
	return uc.servers.Workflow.TerminateWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowTerminateRequest{
		Name:      wf.Name,
		Namespace: wf.Namespace,
	})
}

func (uc *WorkflowUsecase) Delete(ctx context.Context, namespace, name string, force bool) error {
	wf, err := uc.authorizeOn(ctx, namespace, name, authz.WorkflowDelete)
	if err != nil {
		return err
	}
	_, err = uc.servers.Workflow.DeleteWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowDeleteRequest{
		Name:      wf.Name,
		Namespace: wf.Namespace,
		Force:     force,
	})
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
	art, reader, err := uc.servers.Artifacts.Open(uc.argoContext(ctx), wf, nodeID, artifactName, isInput)
	if err != nil {
		return nil, nil, err
	}
	return art, reader, nil
}

func isForbidden(err error) bool {
	return errors.Code(err) == 403
}
