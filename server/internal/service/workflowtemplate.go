package service

import (
	"context"
	"log/slog"

	v1 "argonaut/api/v1"
	"argonaut/internal/biz"
	pkgargo "argonaut/pkg/argo"
)

// WorkflowTemplateService maps the HTTP contract onto the template usecase.
type WorkflowTemplateService struct {
	v1.UnimplementedWorkflowTemplateServiceServer

	log *slog.Logger
	uc  *biz.TemplateUsecase
}

func NewWorkflowTemplateService(uc *biz.TemplateUsecase, logger *slog.Logger) *WorkflowTemplateService {
	return &WorkflowTemplateService{log: logger.With("module", "service/workflowtemplate"), uc: uc}
}

func (s *WorkflowTemplateService) List(ctx context.Context, req *v1.ListWorkflowTemplateRequest) (*v1.ListWorkflowTemplateReply, error) {
	list, err := s.uc.List(ctx, pkgargo.ListOptions{
		Namespace:     req.GetNamespace(),
		LabelSelector: req.GetLabelSelector(),
		NamePattern:   req.GetNamePattern(),
		Limit:         req.GetLimit(),
		ContinueToken: req.GetContinueToken(),
	})
	if err != nil {
		return nil, err
	}
	return &v1.ListWorkflowTemplateReply{List: list}, nil
}

func (s *WorkflowTemplateService) Get(ctx context.Context, req *v1.GetWorkflowTemplateRequest) (*v1.WorkflowTemplateReply, error) {
	tmpl, err := s.uc.Get(ctx, req.GetNamespace(), req.GetName())
	if err != nil {
		return nil, err
	}
	return &v1.WorkflowTemplateReply{Template: tmpl}, nil
}

func (s *WorkflowTemplateService) Create(ctx context.Context, req *v1.CreateWorkflowTemplateRequest) (*v1.WorkflowTemplateReply, error) {
	tmpl, err := parseWorkflowTemplate(req.GetManifest())
	if err != nil {
		return nil, err
	}
	created, err := s.uc.Create(ctx, req.GetNamespace(), tmpl, req.GetMessage())
	if err != nil {
		return nil, err
	}
	return &v1.WorkflowTemplateReply{Template: created}, nil
}

func (s *WorkflowTemplateService) Update(ctx context.Context, req *v1.UpdateWorkflowTemplateRequest) (*v1.WorkflowTemplateReply, error) {
	tmpl, err := parseWorkflowTemplate(req.GetManifest())
	if err != nil {
		return nil, err
	}
	updated, err := s.uc.Update(ctx, req.GetNamespace(), req.GetName(), tmpl, req.GetMessage())
	if err != nil {
		return nil, err
	}
	return &v1.WorkflowTemplateReply{Template: updated}, nil
}

func (s *WorkflowTemplateService) Delete(ctx context.Context, req *v1.DeleteWorkflowTemplateRequest) (*v1.DeleteWorkflowTemplateReply, error) {
	if err := s.uc.Delete(ctx, req.GetNamespace(), req.GetName()); err != nil {
		return nil, err
	}
	return &v1.DeleteWorkflowTemplateReply{}, nil
}

func (s *WorkflowTemplateService) Lint(ctx context.Context, req *v1.LintWorkflowTemplateRequest) (*v1.WorkflowTemplateReply, error) {
	tmpl, err := parseWorkflowTemplate(req.GetManifest())
	if err != nil {
		return nil, err
	}
	linted, err := s.uc.Lint(ctx, req.GetNamespace(), tmpl)
	if err != nil {
		return nil, err
	}
	return &v1.WorkflowTemplateReply{Template: linted}, nil
}

func (s *WorkflowTemplateService) ListRevisions(ctx context.Context, req *v1.TemplateRevisionsRequest) (*v1.TemplateRevisionsReply, error) {
	revs, err := s.uc.Revisions(ctx, req.GetNamespace(), req.GetName())
	if err != nil {
		return nil, err
	}
	return toProtoRevisions(revs), nil
}

func (s *WorkflowTemplateService) GetRevision(ctx context.Context, req *v1.TemplateRevisionRequest) (*v1.TemplateRevisionReply, error) {
	rev, err := s.uc.Revision(ctx, req.GetNamespace(), req.GetName(), req.GetId())
	if err != nil {
		return nil, err
	}
	return &v1.TemplateRevisionReply{Revision: toProtoRevision(rev)}, nil
}

func (s *WorkflowTemplateService) Rollback(ctx context.Context, req *v1.TemplateRollbackRequest) (*v1.WorkflowTemplateReply, error) {
	tmpl, err := s.uc.Rollback(ctx, req.GetNamespace(), req.GetName(), req.GetId(), req.GetResourceVersion())
	if err != nil {
		return nil, err
	}
	return &v1.WorkflowTemplateReply{Template: tmpl}, nil
}

func (s *WorkflowTemplateService) ListComponents(ctx context.Context, req *v1.ListComponentsRequest) (*v1.ListComponentsReply, error) {
	comps, err := s.uc.Components(ctx, req.GetNamespace())
	if err != nil {
		return nil, err
	}
	reply := &v1.ListComponentsReply{}
	for _, c := range comps {
		reply.Components = append(reply.Components, &v1.Component{Cluster: c.Cluster, Editable: c.Editable, Template: c.Template, ClusterTemplate: c.ClusterTemplate})
	}
	return reply, nil
}
