package biz

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"argonaut/internal/authz"
	pkgargo "argonaut/pkg/argo"

	clusterwftmplpkg "github.com/argoproj/argo-workflows/v4/pkg/apiclient/clusterworkflowtemplate"
	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/go-kratos/kratos/v3/errors"
)

// ClusterTemplateUsecase manages ClusterWorkflowTemplates. Grants on a cluster template cover its
// definition only; runs created from it belong to the namespace they run in (DESIGN §4.4).
type ClusterTemplateUsecase struct {
	log     *slog.Logger
	servers *pkgargo.Servers
	cache   *pkgargo.Cache
	authz   *AuthzUsecase
	history *TemplateHistory
}

func NewClusterTemplateUsecase(servers *pkgargo.Servers, cache *pkgargo.Cache, authzUC *AuthzUsecase, history *TemplateHistory, logger *slog.Logger) *ClusterTemplateUsecase {
	return &ClusterTemplateUsecase{
		log:     logger.With("module", "biz/clusterworkflowtemplate"),
		servers: servers,
		cache:   cache,
		authz:   authzUC,
		history: history,
	}
}

func (uc *ClusterTemplateUsecase) argoContext(ctx context.Context) context.Context {
	ctx = pkgargo.WithClients(ctx, uc.servers.Clients)
	if subject := uc.authz.Subject(ctx); subject != "" {
		ctx = pkgargo.WithSubject(ctx, subject, "", "")
	}
	return ctx
}

func (uc *ClusterTemplateUsecase) List(ctx context.Context, opts pkgargo.ListOptions) (*wfv1.ClusterWorkflowTemplateList, error) {
	if err := uc.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	all, err := uc.cache.ListClusterTemplates(ctx, opts.LabelSelector, opts.NamePattern)
	if err != nil {
		return nil, err
	}
	items := make([]wfv1.ClusterWorkflowTemplate, 0, len(all))
	for _, t := range all {
		if uc.authz.Allow(ctx, authz.TemplateList, authz.Resource{ClusterTemplate: t.Name, Labels: t.Labels}) {
			items = append(items, *t)
		}
	}
	window, next, remaining := pkgargo.Page(items, opts.ContinueToken, opts.Limit)
	list := &wfv1.ClusterWorkflowTemplateList{Items: window}
	list.Continue = next
	list.RemainingItemCount = &remaining
	return list, nil
}

func (uc *ClusterTemplateUsecase) Get(ctx context.Context, name string) (*wfv1.ClusterWorkflowTemplate, error) {
	if err := uc.authz.Require(ctx, authz.TemplateGet, ClusterTemplateResource(name)); err != nil {
		return nil, err
	}
	return uc.servers.ClusterTemplate.GetClusterWorkflowTemplate(uc.argoContext(ctx), &clusterwftmplpkg.ClusterWorkflowTemplateGetRequest{Name: name})
}

func (uc *ClusterTemplateUsecase) stamp(ctx context.Context, t *wfv1.ClusterWorkflowTemplate) {
	if t.Annotations == nil {
		t.Annotations = map[string]string{}
	}
	if subject := uc.authz.Subject(ctx); subject != "" {
		t.Annotations[AnnotationLastModifiedBy] = subject
	}
}

// Create needs template:create globally: a cluster template is visible from every namespace, so no
// narrower scope can authorize adding one.
func (uc *ClusterTemplateUsecase) Create(ctx context.Context, t *wfv1.ClusterWorkflowTemplate, message string) (*wfv1.ClusterWorkflowTemplate, error) {
	if err := uc.authz.Require(ctx, authz.TemplateCreate, authz.Global()); err != nil {
		return nil, err
	}
	if err := requireRefsReadable(ctx, uc.authz, "", &t.Spec); err != nil {
		return nil, err
	}
	uc.stamp(ctx, t)
	created, err := uc.servers.ClusterTemplate.CreateClusterWorkflowTemplate(uc.argoContext(ctx), &clusterwftmplpkg.ClusterWorkflowTemplateCreateRequest{Template: t})
	if err != nil {
		return nil, err
	}
	uc.history.RecordClusterTemplate(ctx, created, uc.authz.Subject(ctx), message)
	uc.authz.Audit().Record(ctx, authz.TemplateCreate, ClusterTemplateResource(created.Name), AuditAllowed, "", nil, uc.authz.Revision())
	return created, nil
}

func (uc *ClusterTemplateUsecase) Update(ctx context.Context, name string, t *wfv1.ClusterWorkflowTemplate, message string) (*wfv1.ClusterWorkflowTemplate, error) {
	if err := uc.authz.Require(ctx, authz.TemplateUpdate, ClusterTemplateResource(name)); err != nil {
		return nil, err
	}
	if err := requireRefsReadable(ctx, uc.authz, "", &t.Spec); err != nil {
		return nil, err
	}
	if t.ResourceVersion == "" {
		return nil, errors.BadRequest("invalid_argument", "metadata.resourceVersion is required to update a template; reload it and save again")
	}
	uc.stamp(ctx, t)
	updated, err := uc.servers.ClusterTemplate.UpdateClusterWorkflowTemplate(uc.argoContext(ctx), &clusterwftmplpkg.ClusterWorkflowTemplateUpdateRequest{Name: name, Template: t})
	if err != nil {
		return nil, conflictError(err)
	}
	uc.history.RecordClusterTemplate(ctx, updated, uc.authz.Subject(ctx), message)
	uc.authz.Audit().Record(ctx, authz.TemplateUpdate, ClusterTemplateResource(name), AuditAllowed, message, nil, uc.authz.Revision())
	return updated, nil
}

func (uc *ClusterTemplateUsecase) Delete(ctx context.Context, name string) error {
	res := ClusterTemplateResource(name)
	if err := uc.authz.Require(ctx, authz.TemplateDelete, res); err != nil {
		return err
	}
	if _, err := uc.servers.ClusterTemplate.DeleteClusterWorkflowTemplate(uc.argoContext(ctx), &clusterwftmplpkg.ClusterWorkflowTemplateDeleteRequest{Name: name}); err != nil {
		return err
	}
	uc.authz.Audit().Record(ctx, authz.TemplateDelete, res, AuditAllowed, "", nil, uc.authz.Revision())
	uc.authz.RevokeAllOn(ctx, authz.Grant{ResourceType: authz.ResourceClusterTemplate, Name: name})
	return nil
}

func (uc *ClusterTemplateUsecase) Lint(ctx context.Context, t *wfv1.ClusterWorkflowTemplate) (*wfv1.ClusterWorkflowTemplate, error) {
	if _, exists := uc.cache.GetClusterTemplate(t.Name); exists && t.Name != "" {
		if err := uc.authz.Require(ctx, authz.TemplateUpdate, ClusterTemplateResource(t.Name)); err != nil {
			return nil, err
		}
	} else if err := uc.authz.Require(ctx, authz.TemplateCreate, authz.Global()); err != nil {
		return nil, err
	}
	if err := requireRefsReadable(ctx, uc.authz, "", &t.Spec); err != nil {
		return nil, err
	}
	return uc.servers.ClusterTemplate.LintClusterWorkflowTemplate(uc.argoContext(ctx), &clusterwftmplpkg.ClusterWorkflowTemplateLintRequest{Template: t})
}

func (uc *ClusterTemplateUsecase) Revisions(ctx context.Context, name string) ([]TemplateRevision, error) {
	if err := uc.authz.Require(ctx, authz.TemplateGet, ClusterTemplateResource(name)); err != nil {
		return nil, err
	}
	return uc.history.List(ctx, ScopeCluster, "", name)
}

func (uc *ClusterTemplateUsecase) Revision(ctx context.Context, name, id string) (TemplateRevision, error) {
	if err := uc.authz.Require(ctx, authz.TemplateGet, ClusterTemplateResource(name)); err != nil {
		return TemplateRevision{}, err
	}
	rev, err := uc.history.Get(ctx, id)
	if err != nil {
		return TemplateRevision{}, err
	}
	if rev.Scope != ScopeCluster || rev.Name != name {
		return TemplateRevision{}, errors.NotFound("not_found", "revision not found for this template")
	}
	return rev, nil
}

func (uc *ClusterTemplateUsecase) Rollback(ctx context.Context, name, id, resourceVersion string) (*wfv1.ClusterWorkflowTemplate, error) {
	rev, err := uc.Revision(ctx, name, id)
	if err != nil {
		return nil, err
	}
	var old wfv1.ClusterWorkflowTemplate
	if err := json.Unmarshal(rev.Manifest, &old); err != nil {
		return nil, err
	}
	current, err := uc.Get(ctx, name)
	if err != nil {
		return nil, err
	}
	if resourceVersion != "" && resourceVersion != current.ResourceVersion {
		return nil, errors.Conflict("conflict", "the template was changed by someone else since you loaded it")
	}
	current.Spec = old.Spec
	current.Labels = old.Labels
	current.Annotations = old.Annotations
	return uc.Update(ctx, name, current, fmt.Sprintf("rollback to #%d", rev.Seq))
}
