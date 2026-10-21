package service

import (
	"context"
	"log/slog"

	v1 "argonaut/api/v1"
	"argonaut/internal/biz"
)

// ArchivedWorkflowService maps the archive contract onto the archive usecase.
type ArchivedWorkflowService struct {
	v1.UnimplementedArchivedWorkflowServiceServer

	log *slog.Logger
	uc  *biz.ArchiveUsecase
}

func NewArchivedWorkflowService(uc *biz.ArchiveUsecase, logger *slog.Logger) *ArchivedWorkflowService {
	return &ArchivedWorkflowService{log: logger.With("module", "service/archive"), uc: uc}
}

func (s *ArchivedWorkflowService) List(ctx context.Context, req *v1.ListArchivedWorkflowsRequest) (*v1.ListArchivedWorkflowsReply, error) {
	list, err := s.uc.List(ctx, biz.ArchiveListOptions{
		Namespace:     req.GetNamespace(),
		NamePrefix:    req.GetNamePrefix(),
		LabelSelector: req.GetLabelSelector(),
		Phases:        req.GetPhases(),
		Limit:         int(req.GetLimit()),
		ContinueToken: req.GetContinueToken(),
	})
	if err != nil {
		return nil, err
	}
	return &v1.ListArchivedWorkflowsReply{List: list}, nil
}

func (s *ArchivedWorkflowService) Get(ctx context.Context, req *v1.ArchivedWorkflowRequest) (*v1.ArchivedWorkflowReply, error) {
	wf, err := s.uc.Get(ctx, req.GetUid(), req.GetNamespace())
	if err != nil {
		return nil, err
	}
	return &v1.ArchivedWorkflowReply{Workflow: wf}, nil
}

func (s *ArchivedWorkflowService) Delete(ctx context.Context, req *v1.ArchivedWorkflowRequest) (*v1.DeleteArchivedWorkflowReply, error) {
	if err := s.uc.Delete(ctx, req.GetUid(), req.GetNamespace()); err != nil {
		return nil, err
	}
	return &v1.DeleteArchivedWorkflowReply{}, nil
}

func (s *ArchivedWorkflowService) Resubmit(ctx context.Context, req *v1.ResubmitArchivedWorkflowRequest) (*v1.ArchivedWorkflowReply, error) {
	wf, err := s.uc.Resubmit(ctx, req.GetUid(), req.GetMemoized(), req.GetParameters())
	if err != nil {
		return nil, err
	}
	return &v1.ArchivedWorkflowReply{Workflow: wf}, nil
}

func (s *ArchivedWorkflowService) Retry(ctx context.Context, req *v1.RetryArchivedWorkflowRequest) (*v1.ArchivedWorkflowReply, error) {
	wf, err := s.uc.Retry(ctx, req.GetUid(), req.GetRestartSuccessful(), req.GetNodeFieldSelector(), req.GetParameters())
	if err != nil {
		return nil, err
	}
	return &v1.ArchivedWorkflowReply{Workflow: wf}, nil
}

func (s *ArchivedWorkflowService) Logs(req *v1.ArchivedWorkflowLogRequest, stream v1.ArchivedWorkflowService_LogsServer) error {
	ctx := stream.Context()
	send := sendOrStop(ctx, stream.Send)
	err := s.uc.Logs(ctx, req.GetUid(), req.GetNodeId(), req.GetGrep(), func(content, podName string) error {
		return send(&v1.WorkflowLogEntry{Content: content, PodName: podName})
	})
	return finishStream(ctx, err)
}
