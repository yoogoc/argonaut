package biz

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"argonaut/internal/authz"
	pkgargo "argonaut/pkg/argo"

	workflowtemplatepkg "github.com/argoproj/argo-workflows/v4/pkg/apiclient/workflowtemplate"
	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/go-kratos/kratos/v3/errors"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

// TemplateUsecase manages WorkflowTemplates, the resources permissions are granted on.
type TemplateUsecase struct {
	log     *slog.Logger
	servers *pkgargo.Servers
	cache   *pkgargo.Cache
	authz   *AuthzUsecase
	history *TemplateHistory
}

func NewTemplateUsecase(servers *pkgargo.Servers, cache *pkgargo.Cache, authzUC *AuthzUsecase, history *TemplateHistory, logger *slog.Logger) *TemplateUsecase {
	return &TemplateUsecase{
		log:     logger.With("module", "biz/workflowtemplate"),
		servers: servers,
		cache:   cache,
		authz:   authzUC,
		history: history,
	}
}

func (uc *TemplateUsecase) argoContext(ctx context.Context) context.Context {
	ctx = pkgargo.WithClients(ctx, uc.servers.Clients)
	if subject := uc.authz.Subject(ctx); subject != "" {
		ctx = pkgargo.WithSubject(ctx, subject, "", "")
	}
	return ctx
}

// List returns the templates the caller may see, from the informer cache.
func (uc *TemplateUsecase) List(ctx context.Context, opts pkgargo.ListOptions) (*wfv1.WorkflowTemplateList, error) {
	if err := uc.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	all, err := uc.cache.ListTemplates(ctx, uc.servers.NamespaceFor(opts.Namespace), opts.LabelSelector, opts.NamePattern)
	if err != nil {
		return nil, err
	}
	items := make([]wfv1.WorkflowTemplate, 0, len(all))
	for _, t := range all {
		if uc.authz.Allow(ctx, authz.TemplateList, TemplateObjectResource(t)) {
			items = append(items, *t)
		}
	}
	window, next, remaining := pkgargo.Page(items, opts.ContinueToken, opts.Limit)
	list := &wfv1.WorkflowTemplateList{Items: window}
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

// stamp records the editor on the object itself, so the cluster shows who last saved through argonaut.
func (uc *TemplateUsecase) stamp(ctx context.Context, meta map[string]string) map[string]string {
	if meta == nil {
		meta = map[string]string{}
	}
	if subject := uc.authz.Subject(ctx); subject != "" {
		meta[AnnotationLastModifiedBy] = subject
	}
	return meta
}

// Create needs a namespace-wide grant: the template does not exist yet, so there is no narrower
// scope that could authorize creating it.
func (uc *TemplateUsecase) Create(ctx context.Context, namespace string, tmpl *wfv1.WorkflowTemplate, message string) (*wfv1.WorkflowTemplate, error) {
	ns := uc.servers.NamespaceFor(namespace)
	if err := uc.authz.Require(ctx, authz.TemplateCreate, NamespaceResource(ns)); err != nil {
		return nil, err
	}
	if err := uc.requireRefsReadable(ctx, ns, &tmpl.Spec); err != nil {
		return nil, err
	}
	tmpl.Annotations = uc.stamp(ctx, tmpl.Annotations)
	created, err := uc.servers.WorkflowTemplate.CreateWorkflowTemplate(uc.argoContext(ctx), &workflowtemplatepkg.WorkflowTemplateCreateRequest{
		Namespace: ns,
		Template:  tmpl,
	})
	if err != nil {
		return nil, err
	}
	uc.history.RecordTemplate(ctx, created, uc.authz.Subject(ctx), message)
	uc.authz.Audit().Record(ctx, authz.TemplateCreate, TemplateResource(ns, created.Name), AuditAllowed, "", nil, uc.authz.Revision())
	return created, nil
}

// Update saves a template with optimistic concurrency: the caller's resourceVersion must match the
// stored one, otherwise Kubernetes refuses with 409 and the editor offers a three-way merge.
func (uc *TemplateUsecase) Update(ctx context.Context, namespace, name string, tmpl *wfv1.WorkflowTemplate, message string) (*wfv1.WorkflowTemplate, error) {
	ns := uc.servers.NamespaceFor(namespace)
	if err := uc.authz.Require(ctx, authz.TemplateUpdate, TemplateResource(ns, name)); err != nil {
		return nil, err
	}
	if err := uc.requireRefsReadable(ctx, ns, &tmpl.Spec); err != nil {
		return nil, err
	}
	if tmpl.ResourceVersion == "" {
		return nil, errors.BadRequest("invalid_argument", "metadata.resourceVersion is required to update a template; reload it and save again")
	}
	tmpl.Annotations = uc.stamp(ctx, tmpl.Annotations)
	updated, err := uc.servers.WorkflowTemplate.UpdateWorkflowTemplate(uc.argoContext(ctx), &workflowtemplatepkg.WorkflowTemplateUpdateRequest{
		Namespace: ns,
		Name:      name,
		Template:  tmpl,
	})
	if err != nil {
		return nil, conflictError(err)
	}
	uc.history.RecordTemplate(ctx, updated, uc.authz.Subject(ctx), message)
	uc.authz.Audit().Record(ctx, authz.TemplateUpdate, TemplateResource(ns, name), AuditAllowed, message, map[string]any{"resourceVersion": updated.ResourceVersion}, uc.authz.Revision())
	return updated, nil
}

// conflictError turns Kubernetes' stale-resourceVersion refusal into a 409 the UI recognises.
func conflictError(err error) error {
	if apierrors.IsConflict(err) || errors.Code(err) == 409 {
		return errors.Conflict("conflict", "the template was changed by someone else since you loaded it")
	}
	return err
}

// Delete removes a template and revokes every grant on it, so a template later created under the same
// name does not silently inherit them. Revoking after the delete means a failed revoke leaves an orphan
// grant (listed on the permissions page), never a template without its grants.
func (uc *TemplateUsecase) Delete(ctx context.Context, namespace, name string) error {
	ns := uc.servers.NamespaceFor(namespace)
	res := TemplateResource(ns, name)
	if err := uc.authz.Require(ctx, authz.TemplateDelete, res); err != nil {
		return err
	}
	if _, err := uc.servers.WorkflowTemplate.DeleteWorkflowTemplate(uc.argoContext(ctx), &workflowtemplatepkg.WorkflowTemplateDeleteRequest{
		Namespace: ns,
		Name:      name,
	}); err != nil {
		return err
	}
	uc.authz.Audit().Record(ctx, authz.TemplateDelete, res, AuditAllowed, "", nil, uc.authz.Revision())
	uc.authz.RevokeAllOn(ctx, authz.Grant{ResourceType: authz.ResourceTemplate, Namespace: ns, Name: name})
	return nil
}

// Lint validates a template before it is saved. It is a create- or update-shaped action depending on
// whether the template exists, and it also checks every template the spec references is readable.
func (uc *TemplateUsecase) Lint(ctx context.Context, namespace string, tmpl *wfv1.WorkflowTemplate) (*wfv1.WorkflowTemplate, error) {
	ns := uc.servers.NamespaceFor(namespace)
	if _, exists := uc.cache.GetTemplate(ns, tmpl.Name); exists && tmpl.Name != "" {
		if err := uc.authz.Require(ctx, authz.TemplateUpdate, TemplateResource(ns, tmpl.Name)); err != nil {
			return nil, err
		}
	} else if err := uc.authz.Require(ctx, authz.TemplateCreate, NamespaceResource(ns)); err != nil {
		return nil, err
	}
	if err := uc.requireRefsReadable(ctx, ns, &tmpl.Spec); err != nil {
		return nil, err
	}
	return uc.servers.WorkflowTemplate.LintWorkflowTemplate(uc.argoContext(ctx), &workflowtemplatepkg.WorkflowTemplateLintRequest{
		Namespace: ns,
		Template:  tmpl,
	})
}

// requireRefsReadable refuses a spec that references a template the caller may not read: referencing
// one would otherwise be a way to run, and through the run's node status read, someone else's
// template (DESIGN §3.3).
func (uc *TemplateUsecase) requireRefsReadable(ctx context.Context, namespace string, spec *wfv1.WorkflowSpec) error {
	return requireRefsReadable(ctx, uc.authz, namespace, spec)
}

func requireRefsReadable(ctx context.Context, az *AuthzUsecase, namespace string, spec *wfv1.WorkflowSpec) error {
	seen := map[string]bool{}
	check := func(ref *wfv1.TemplateRef) error {
		if ref == nil || ref.Name == "" {
			return nil
		}
		key := fmt.Sprintf("%v/%s", ref.ClusterScope, ref.Name)
		if seen[key] {
			return nil
		}
		seen[key] = true
		res := TemplateResource(namespace, ref.Name)
		if ref.ClusterScope {
			res = ClusterTemplateResource(ref.Name)
		}
		return az.Require(ctx, authz.TemplateGet, res)
	}
	for i := range spec.Templates {
		t := &spec.Templates[i]
		if t.DAG != nil {
			for j := range t.DAG.Tasks {
				if err := check(t.DAG.Tasks[j].TemplateRef); err != nil {
					return err
				}
			}
		}
		for _, group := range t.Steps {
			for k := range group.Steps {
				if err := check(group.Steps[k].TemplateRef); err != nil {
					return err
				}
			}
		}
	}
	if ref := spec.WorkflowTemplateRef; ref != nil && ref.Name != "" {
		return check(&wfv1.TemplateRef{Name: ref.Name, ClusterScope: ref.ClusterScope})
	}
	return nil
}

// Revisions lists a template's recorded history.
func (uc *TemplateUsecase) Revisions(ctx context.Context, namespace, name string) ([]TemplateRevision, error) {
	ns := uc.servers.NamespaceFor(namespace)
	if err := uc.authz.Require(ctx, authz.TemplateGet, TemplateResource(ns, name)); err != nil {
		return nil, err
	}
	return uc.history.List(ctx, ScopeNamespace, ns, name)
}

// Revision returns one recorded version.
func (uc *TemplateUsecase) Revision(ctx context.Context, namespace, name, id string) (TemplateRevision, error) {
	ns := uc.servers.NamespaceFor(namespace)
	if err := uc.authz.Require(ctx, authz.TemplateGet, TemplateResource(ns, name)); err != nil {
		return TemplateRevision{}, err
	}
	rev, err := uc.history.Get(ctx, id)
	if err != nil {
		return TemplateRevision{}, err
	}
	if rev.Scope != ScopeNamespace || rev.Namespace != ns || rev.Name != name {
		return TemplateRevision{}, errors.NotFound("not_found", "revision not found for this template")
	}
	return rev, nil
}

// Rollback saves an old revision's spec as a new revision. It is an ordinary update — same
// permission, same optimistic concurrency against the version the caller is looking at.
func (uc *TemplateUsecase) Rollback(ctx context.Context, namespace, name, id, resourceVersion string) (*wfv1.WorkflowTemplate, error) {
	rev, err := uc.Revision(ctx, namespace, name, id)
	if err != nil {
		return nil, err
	}
	var old wfv1.WorkflowTemplate
	if err := json.Unmarshal(rev.Manifest, &old); err != nil {
		return nil, err
	}
	current, err := uc.Get(ctx, namespace, name)
	if err != nil {
		return nil, err
	}
	if resourceVersion != "" && resourceVersion != current.ResourceVersion {
		return nil, errors.Conflict("conflict", "the template was changed by someone else since you loaded it")
	}
	current.Spec = old.Spec
	current.Labels = old.Labels
	current.Annotations = old.Annotations
	return uc.Update(ctx, namespace, name, current, fmt.Sprintf("rollback to #%d", rev.Seq))
}

// ComponentRef is one entry of the editor's component palette.
type ComponentRef struct {
	Cluster         bool
	Template        *wfv1.WorkflowTemplate
	ClusterTemplate *wfv1.ClusterWorkflowTemplate
	Editable        bool
}

// Components lists the namespace's and the cluster's component templates the caller may read.
func (uc *TemplateUsecase) Components(ctx context.Context, namespace string) ([]ComponentRef, error) {
	if err := uc.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	ns := uc.servers.NamespaceFor(namespace)
	selector := LabelComponent + "=true"
	var out []ComponentRef
	local, err := uc.cache.ListTemplates(ctx, ns, selector, "")
	if err != nil {
		return nil, err
	}
	for _, t := range local {
		res := TemplateObjectResource(t)
		if uc.authz.Allow(ctx, authz.TemplateGet, res) {
			out = append(out, ComponentRef{Template: t, Editable: uc.authz.Allow(ctx, authz.TemplateUpdate, res)})
		}
	}
	cluster, err := uc.cache.ListClusterTemplates(ctx, selector, "")
	if err != nil {
		return nil, err
	}
	for _, t := range cluster {
		res := ClusterTemplateResource(t.Name)
		if uc.authz.Allow(ctx, authz.TemplateGet, res) {
			out = append(out, ComponentRef{Cluster: true, ClusterTemplate: t, Editable: uc.authz.Allow(ctx, authz.TemplateUpdate, res)})
		}
	}
	return out, nil
}
