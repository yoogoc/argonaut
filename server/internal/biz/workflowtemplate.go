package biz

import (
	"context"
	"log/slog"

	"argonaut/internal/authz"
	pkgargo "argonaut/pkg/argo"

	workflowtemplatepkg "github.com/argoproj/argo-workflows/v4/pkg/apiclient/workflowtemplate"
	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
)

// TemplateUsecase manages WorkflowTemplates, the resources permissions are granted on.
type TemplateUsecase struct {
	log     *slog.Logger
	servers *pkgargo.Servers
	authz   *AuthzUsecase
}

func NewTemplateUsecase(servers *pkgargo.Servers, authzUC *AuthzUsecase, logger *slog.Logger) *TemplateUsecase {
	return &TemplateUsecase{
		log:     logger.With("module", "biz/workflowtemplate"),
		servers: servers,
		authz:   authzUC,
	}
}

func (uc *TemplateUsecase) argoContext(ctx context.Context) context.Context {
	ctx = pkgargo.WithClients(ctx, uc.servers.Clients)
	if subject := uc.authz.Subject(ctx); subject != "" {
		ctx = pkgargo.WithSubject(ctx, subject, "", "")
	}
	return ctx
}

// List returns the templates the caller may see. Unlike most resources this filter is the whole
// access story for the list page: a user with one template grant sees exactly that template.
func (uc *TemplateUsecase) List(ctx context.Context, opts pkgargo.ListOptions) (*wfv1.WorkflowTemplateList, error) {
	if err := uc.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	list, err := uc.servers.ListWorkflowTemplates(uc.argoContext(ctx), opts)
	if err != nil {
		return nil, err
	}
	items := make([]wfv1.WorkflowTemplate, 0, len(list.Items))
	for i := range list.Items {
		if uc.authz.Allow(ctx, authz.TemplateList, TemplateResource(list.Items[i].Namespace, list.Items[i].Name)) {
			items = append(items, list.Items[i])
		}
	}
	window, next, remaining := pkgargo.Page(items, opts.ContinueToken, opts.Limit)
	list.Items = window
	list.Continue = next
	list.RemainingItemCount = &remaining
	return list, nil
}

func (uc *TemplateUsecase) Get(ctx context.Context, namespace, name string) (*wfv1.WorkflowTemplate, error) {
	ns := uc.servers.NamespaceFor(namespace)
	if err := uc.authz.Require(ctx, authz.TemplateGet, TemplateResource(ns, name)); err != nil {
		return nil, err
	}
	return uc.servers.WorkflowTemplate.GetWorkflowTemplate(uc.argoContext(ctx), &workflowtemplatepkg.WorkflowTemplateGetRequest{
		Namespace: ns,
		Name:      name,
	})
}

// Create needs a namespace-wide grant: the template does not exist yet, so there is no narrower
// scope that could authorize creating it.
func (uc *TemplateUsecase) Create(ctx context.Context, namespace string, tmpl *wfv1.WorkflowTemplate) (*wfv1.WorkflowTemplate, error) {
	ns := uc.servers.NamespaceFor(namespace)
	if err := uc.authz.Require(ctx, authz.TemplateCreate, NamespaceResource(ns)); err != nil {
		return nil, err
	}
	return uc.servers.WorkflowTemplate.CreateWorkflowTemplate(uc.argoContext(ctx), &workflowtemplatepkg.WorkflowTemplateCreateRequest{
		Namespace: ns,
		Template:  tmpl,
	})
}

func (uc *TemplateUsecase) Update(ctx context.Context, namespace, name string, tmpl *wfv1.WorkflowTemplate) (*wfv1.WorkflowTemplate, error) {
	ns := uc.servers.NamespaceFor(namespace)
	if err := uc.authz.Require(ctx, authz.TemplateUpdate, TemplateResource(ns, name)); err != nil {
		return nil, err
	}
	return uc.servers.WorkflowTemplate.UpdateWorkflowTemplate(uc.argoContext(ctx), &workflowtemplatepkg.WorkflowTemplateUpdateRequest{
		Namespace: ns,
		Name:      name,
		Template:  tmpl,
	})
}

func (uc *TemplateUsecase) Delete(ctx context.Context, namespace, name string) error {
	ns := uc.servers.NamespaceFor(namespace)
	if err := uc.authz.Require(ctx, authz.TemplateDelete, TemplateResource(ns, name)); err != nil {
		return err
	}
	_, err := uc.servers.WorkflowTemplate.DeleteWorkflowTemplate(uc.argoContext(ctx), &workflowtemplatepkg.WorkflowTemplateDeleteRequest{
		Namespace: ns,
		Name:      name,
	})
	return err
}

// Lint validates a template before it is saved.
func (uc *TemplateUsecase) Lint(ctx context.Context, namespace string, tmpl *wfv1.WorkflowTemplate) (*wfv1.WorkflowTemplate, error) {
	ns := uc.servers.NamespaceFor(namespace)
	// Linting is a create-shaped action: it validates a template that may not exist yet.
	if err := uc.authz.Require(ctx, authz.TemplateCreate, NamespaceResource(ns)); err != nil {
		return nil, err
	}
	return uc.servers.WorkflowTemplate.LintWorkflowTemplate(uc.argoContext(ctx), &workflowtemplatepkg.WorkflowTemplateLintRequest{
		Namespace: ns,
		Template:  tmpl,
	})
}
