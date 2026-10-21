package service

import (
	"context"
	"log/slog"

	v1 "argonaut/api/v1"
	"argonaut/internal/biz"
	pkgargo "argonaut/pkg/argo"
)

// ClusterWorkflowTemplateService maps the HTTP contract onto the cluster template usecase.
type ClusterWorkflowTemplateService struct {
	v1.UnimplementedClusterWorkflowTemplateServiceServer

	log *slog.Logger
	uc  *biz.ClusterTemplateUsecase
}

func NewClusterWorkflowTemplateService(uc *biz.ClusterTemplateUsecase, logger *slog.Logger) *ClusterWorkflowTemplateService {
	return &ClusterWorkflowTemplateService{log: logger.With("module", "service/clusterworkflowtemplate"), uc: uc}
}

func (s *ClusterWorkflowTemplateService) List(ctx context.Context, req *v1.ListClusterWorkflowTemplateRequest) (*v1.ListClusterWorkflowTemplateReply, error) {
	list, err := s.uc.List(ctx, pkgargo.ListOptions{
		LabelSelector: req.GetLabelSelector(),
		NamePattern:   req.GetNamePattern(),
		Limit:         req.GetLimit(),
		ContinueToken: req.GetContinueToken(),
	})
	if err != nil {
		return nil, err
	}
	return &v1.ListClusterWorkflowTemplateReply{List: list}, nil
}

func (s *ClusterWorkflowTemplateService) Get(ctx context.Context, req *v1.GetClusterWorkflowTemplateRequest) (*v1.ClusterWorkflowTemplateReply, error) {
	t, err := s.uc.Get(ctx, req.GetName())
	if err != nil {
		return nil, err
	}
	return &v1.ClusterWorkflowTemplateReply{Template: t}, nil
}

func (s *ClusterWorkflowTemplateService) Create(ctx context.Context, req *v1.CreateClusterWorkflowTemplateRequest) (*v1.ClusterWorkflowTemplateReply, error) {
	t, err := parseClusterWorkflowTemplate(req.GetManifest())
	if err != nil {
		return nil, err
	}
	created, err := s.uc.Create(ctx, t, req.GetMessage())
	if err != nil {
		return nil, err
	}
	return &v1.ClusterWorkflowTemplateReply{Template: created}, nil
}

func (s *ClusterWorkflowTemplateService) Update(ctx context.Context, req *v1.UpdateClusterWorkflowTemplateRequest) (*v1.ClusterWorkflowTemplateReply, error) {
	t, err := parseClusterWorkflowTemplate(req.GetManifest())
	if err != nil {
		return nil, err
	}
	updated, err := s.uc.Update(ctx, req.GetName(), t, req.GetMessage())
	if err != nil {
		return nil, err
	}
	return &v1.ClusterWorkflowTemplateReply{Template: updated}, nil
}

func (s *ClusterWorkflowTemplateService) Delete(ctx context.Context, req *v1.GetClusterWorkflowTemplateRequest) (*v1.DeleteClusterWorkflowTemplateReply, error) {
	if err := s.uc.Delete(ctx, req.GetName()); err != nil {
		return nil, err
	}
	return &v1.DeleteClusterWorkflowTemplateReply{}, nil
}

func (s *ClusterWorkflowTemplateService) Lint(ctx context.Context, req *v1.LintClusterWorkflowTemplateRequest) (*v1.ClusterWorkflowTemplateReply, error) {
	t, err := parseClusterWorkflowTemplate(req.GetManifest())
	if err != nil {
		return nil, err
	}
	linted, err := s.uc.Lint(ctx, t)
	if err != nil {
		return nil, err
	}
	return &v1.ClusterWorkflowTemplateReply{Template: linted}, nil
}

func (s *ClusterWorkflowTemplateService) ListRevisions(ctx context.Context, req *v1.GetClusterWorkflowTemplateRequest) (*v1.TemplateRevisionsReply, error) {
	revs, err := s.uc.Revisions(ctx, req.GetName())
	if err != nil {
		return nil, err
	}
	return toProtoRevisions(revs), nil
}

func (s *ClusterWorkflowTemplateService) GetRevision(ctx context.Context, req *v1.ClusterTemplateRevisionRequest) (*v1.TemplateRevisionReply, error) {
	rev, err := s.uc.Revision(ctx, req.GetName(), req.GetId())
	if err != nil {
		return nil, err
	}
	return &v1.TemplateRevisionReply{Revision: toProtoRevision(rev)}, nil
}

func (s *ClusterWorkflowTemplateService) Rollback(ctx context.Context, req *v1.ClusterTemplateRollbackRequest) (*v1.ClusterWorkflowTemplateReply, error) {
	t, err := s.uc.Rollback(ctx, req.GetName(), req.GetId(), req.GetResourceVersion())
	if err != nil {
		return nil, err
	}
	return &v1.ClusterWorkflowTemplateReply{Template: t}, nil
}
