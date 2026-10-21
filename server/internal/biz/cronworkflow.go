package biz

import (
	"context"
	"log/slog"

	"argonaut/internal/authz"
	pkgargo "argonaut/pkg/argo"

	cronworkflowpkg "github.com/argoproj/argo-workflows/v4/pkg/apiclient/cronworkflow"
	workflowpkg "github.com/argoproj/argo-workflows/v4/pkg/apiclient/workflow"
	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
)

// CronUsecase manages scheduled workflows. Like plain workflows, a cron workflow's permissions are
// those of the template it references; a cron with an inline spec falls back to namespace scope.
type CronUsecase struct {
	log     *slog.Logger
	servers *pkgargo.Servers
	authz   *AuthzUsecase
}

func NewCronUsecase(servers *pkgargo.Servers, authzUC *AuthzUsecase, logger *slog.Logger) *CronUsecase {
	return &CronUsecase{
		log:     logger.With("module", "biz/cronworkflow"),
		servers: servers,
		authz:   authzUC,
	}
}

func (uc *CronUsecase) argoContext(ctx context.Context) context.Context {
	ctx = pkgargo.WithClients(ctx, uc.servers.Clients)
	if subject := uc.authz.Subject(ctx); subject != "" {
		ctx = pkgargo.WithSubject(ctx, subject, "", "")
	}
	return ctx
}

func (uc *CronUsecase) List(ctx context.Context, opts pkgargo.ListOptions) (*wfv1.CronWorkflowList, error) {
	if err := uc.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	list, err := uc.servers.ListCronWorkflows(uc.argoContext(ctx), opts)
	if err != nil {
		return nil, err
	}
	items := make([]wfv1.CronWorkflow, 0, len(list.Items))
	for i := range list.Items {
		if uc.authz.Allow(ctx, authz.CronList, CronWorkflowResource(&list.Items[i])) {
			items = append(items, list.Items[i])
		}
	}
	window, next, remaining := pkgargo.Page(items, opts.ContinueToken, opts.Limit)
	list.Items = window
	list.Continue = next
	list.RemainingItemCount = &remaining
	return list, nil
}

func (uc *CronUsecase) Get(ctx context.Context, namespace, name string) (*wfv1.CronWorkflow, error) {
	cron, err := uc.authorizeOn(ctx, namespace, name, authz.CronGet)
	if err != nil {
		return nil, err
	}
	return cron, nil
}

// authorizeOn reads the cron workflow so its template scope is known, then checks the action.
func (uc *CronUsecase) authorizeOn(ctx context.Context, namespace, name string, action authz.Action) (*wfv1.CronWorkflow, error) {
	cron, err := uc.servers.GetCronWorkflow(uc.argoContext(ctx), namespace, name)
	if err != nil {
		return nil, err
	}
	if err := uc.authz.Require(ctx, action, CronWorkflowResource(cron)); err != nil {
		return nil, err
	}
	return cron, nil
}

// Create authorizes against the referenced template when there is one, so a template editor can
// schedule their own template without needing rights over the whole namespace.
func (uc *CronUsecase) Create(ctx context.Context, namespace string, cron *wfv1.CronWorkflow) (*wfv1.CronWorkflow, error) {
	ns := uc.servers.NamespaceFor(namespace)
	cron.Namespace = ns
	if err := uc.authz.Require(ctx, authz.CronCreate, CronWorkflowResource(cron)); err != nil {
		return nil, err
	}
	return uc.servers.CronWorkflow.CreateCronWorkflow(uc.argoContext(ctx), &cronworkflowpkg.CreateCronWorkflowRequest{
		Namespace:    ns,
		CronWorkflow: cron,
	})
}

// Update requires rights on both the stored cron and the incoming one, so a cron cannot be
// re-pointed at a template the caller has no access to.
func (uc *CronUsecase) Update(ctx context.Context, namespace, name string, cron *wfv1.CronWorkflow) (*wfv1.CronWorkflow, error) {
	if _, err := uc.authorizeOn(ctx, namespace, name, authz.CronUpdate); err != nil {
		return nil, err
	}
	ns := uc.servers.NamespaceFor(namespace)
	cron.Namespace = ns
	if err := uc.authz.Require(ctx, authz.CronUpdate, CronWorkflowResource(cron)); err != nil {
		return nil, err
	}
	return uc.servers.CronWorkflow.UpdateCronWorkflow(uc.argoContext(ctx), &cronworkflowpkg.UpdateCronWorkflowRequest{
		Namespace:    ns,
		Name:         name,
		CronWorkflow: cron,
	})
}

func (uc *CronUsecase) Delete(ctx context.Context, namespace, name string) error {
	cron, err := uc.authorizeOn(ctx, namespace, name, authz.CronDelete)
	if err != nil {
		return err
	}
	_, err = uc.servers.CronWorkflow.DeleteCronWorkflow(uc.argoContext(ctx), &cronworkflowpkg.DeleteCronWorkflowRequest{
		Namespace: cron.Namespace,
		Name:      cron.Name,
	})
	return err
}

func (uc *CronUsecase) Suspend(ctx context.Context, namespace, name string) (*wfv1.CronWorkflow, error) {
	cron, err := uc.authorizeOn(ctx, namespace, name, authz.CronSuspend)
	if err != nil {
		return nil, err
	}
	return uc.servers.CronWorkflow.SuspendCronWorkflow(uc.argoContext(ctx), &cronworkflowpkg.CronWorkflowSuspendRequest{
		Namespace: cron.Namespace,
		Name:      cron.Name,
	})
}

func (uc *CronUsecase) Resume(ctx context.Context, namespace, name string) (*wfv1.CronWorkflow, error) {
	cron, err := uc.authorizeOn(ctx, namespace, name, authz.CronResume)
	if err != nil {
		return nil, err
	}
	return uc.servers.CronWorkflow.ResumeCronWorkflow(uc.argoContext(ctx), &cronworkflowpkg.CronWorkflowResumeRequest{
		Namespace: cron.Namespace,
		Name:      cron.Name,
	})
}

// RunNow triggers one immediate execution. Argo exposes no such API, so we do what its cron
// controller does: convert the CronWorkflow into a Workflow and create it. Using Argo's own
// converter means the produced workflow carries the same labels, ownership and spec the scheduler
// would have produced, so it shows up in the cron's run history like any scheduled run.
func (uc *CronUsecase) RunNow(ctx context.Context, namespace, name string) (*wfv1.Workflow, error) {
	cron, err := uc.authorizeOn(ctx, namespace, name, authz.CronRun)
	if err != nil {
		return nil, err
	}
	wf := common.ConvertCronWorkflowToWorkflow(cron)
	// Record who forced the run; scheduled runs have no such annotation, which makes manual runs
	// distinguishable in the history.
	if wf.Labels == nil {
		wf.Labels = map[string]string{}
	}
	if subject := uc.authz.Subject(ctx); subject != "" {
		wf.Labels[common.LabelKeyCreator] = sanitizeLabelValue(subject)
	}

	return uc.servers.Workflow.CreateWorkflow(uc.argoContext(ctx), &workflowpkg.WorkflowCreateRequest{
		Namespace: cron.Namespace,
		Workflow:  wf,
	})
}

func (uc *CronUsecase) Lint(ctx context.Context, namespace string, cron *wfv1.CronWorkflow) (*wfv1.CronWorkflow, error) {
	ns := uc.servers.NamespaceFor(namespace)
	cron.Namespace = ns
	if err := uc.authz.Require(ctx, authz.CronCreate, CronWorkflowResource(cron)); err != nil {
		return nil, err
	}
	return uc.servers.CronWorkflow.LintCronWorkflow(uc.argoContext(ctx), &cronworkflowpkg.LintCronWorkflowRequest{
		Namespace:    ns,
		CronWorkflow: cron,
	})
}

// sanitizeLabelValue makes an OIDC subject usable as a Kubernetes label value, which allows only
// alphanumerics, '-', '_' and '.', up to 63 characters.
func sanitizeLabelValue(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			out = append(out, r)
		default:
			out = append(out, '-')
		}
	}
	// Trim non-alphanumeric edges, which Kubernetes rejects.
	for len(out) > 0 && !isAlphanumeric(out[0]) {
		out = out[1:]
	}
	for len(out) > 0 && !isAlphanumeric(out[len(out)-1]) {
		out = out[:len(out)-1]
	}
	if len(out) > 63 {
		out = out[:63]
		for len(out) > 0 && !isAlphanumeric(out[len(out)-1]) {
			out = out[:len(out)-1]
		}
	}
	return string(out)
}

func isAlphanumeric(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
}
