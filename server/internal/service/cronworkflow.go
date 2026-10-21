package service

import (
	"context"
	"log/slog"

	v1 "argonaut/api/v1"
	"argonaut/internal/biz"
	pkgargo "argonaut/pkg/argo"
)

// CronWorkflowService maps the HTTP contract onto the cron usecase.
type CronWorkflowService struct {
	v1.UnimplementedCronWorkflowServiceServer

	log *slog.Logger
	uc  *biz.CronUsecase
}

func NewCronWorkflowService(uc *biz.CronUsecase, logger *slog.Logger) *CronWorkflowService {
	return &CronWorkflowService{log: logger.With("module", "service/cronworkflow"), uc: uc}
}

func (s *CronWorkflowService) List(ctx context.Context, req *v1.ListCronWorkflowRequest) (*v1.ListCronWorkflowReply, error) {
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
	return &v1.ListCronWorkflowReply{List: list}, nil
}

func (s *CronWorkflowService) Get(ctx context.Context, req *v1.GetCronWorkflowRequest) (*v1.CronWorkflowReply, error) {
	cron, err := s.uc.Get(ctx, req.GetNamespace(), req.GetName())
	if err != nil {
		return nil, err
	}
	return &v1.CronWorkflowReply{CronWorkflow: cron}, nil
}

func (s *CronWorkflowService) Create(ctx context.Context, req *v1.CreateCronWorkflowRequest) (*v1.CronWorkflowReply, error) {
	cron, err := parseCronWorkflow(req.GetManifest())
	if err != nil {
		return nil, err
	}
	created, err := s.uc.Create(ctx, req.GetNamespace(), cron)
	if err != nil {
		return nil, err
	}
	return &v1.CronWorkflowReply{CronWorkflow: created}, nil
}

func (s *CronWorkflowService) Update(ctx context.Context, req *v1.UpdateCronWorkflowRequest) (*v1.CronWorkflowReply, error) {
	cron, err := parseCronWorkflow(req.GetManifest())
	if err != nil {
		return nil, err
	}
	updated, err := s.uc.Update(ctx, req.GetNamespace(), req.GetName(), cron)
	if err != nil {
		return nil, err
	}
	return &v1.CronWorkflowReply{CronWorkflow: updated}, nil
}

func (s *CronWorkflowService) Delete(ctx context.Context, req *v1.DeleteCronWorkflowRequest) (*v1.DeleteCronWorkflowReply, error) {
	if err := s.uc.Delete(ctx, req.GetNamespace(), req.GetName()); err != nil {
		return nil, err
	}
	return &v1.DeleteCronWorkflowReply{}, nil
}

func (s *CronWorkflowService) Suspend(ctx context.Context, req *v1.CronWorkflowActionRequest) (*v1.CronWorkflowReply, error) {
	cron, err := s.uc.Suspend(ctx, req.GetNamespace(), req.GetName())
	if err != nil {
		return nil, err
	}
	return &v1.CronWorkflowReply{CronWorkflow: cron}, nil
}

func (s *CronWorkflowService) Resume(ctx context.Context, req *v1.CronWorkflowActionRequest) (*v1.CronWorkflowReply, error) {
	cron, err := s.uc.Resume(ctx, req.GetNamespace(), req.GetName())
	if err != nil {
		return nil, err
	}
	return &v1.CronWorkflowReply{CronWorkflow: cron}, nil
}

func (s *CronWorkflowService) RunNow(ctx context.Context, req *v1.CronWorkflowActionRequest) (*v1.RunNowReply, error) {
	wf, err := s.uc.RunNow(ctx, req.GetNamespace(), req.GetName())
	if err != nil {
		return nil, err
	}
	return &v1.RunNowReply{Workflow: wf}, nil
}

func (s *CronWorkflowService) Lint(ctx context.Context, req *v1.LintCronWorkflowRequest) (*v1.CronWorkflowReply, error) {
	cron, err := parseCronWorkflow(req.GetManifest())
	if err != nil {
		return nil, err
	}
	linted, err := s.uc.Lint(ctx, req.GetNamespace(), cron)
	if err != nil {
		return nil, err
	}
	return &v1.CronWorkflowReply{CronWorkflow: linted}, nil
}
