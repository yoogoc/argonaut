package service

import (
	"sort"
	"time"

	"context"
	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	robfig "github.com/robfig/cron/v3"
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
	return &v1.CronWorkflowReply{CronWorkflow: cron, NextRuns: nextRuns(cron, 5)}, nil
}

// nextRuns merges the upcoming times of every schedule a cron workflow has.
func nextRuns(cron *wfv1.CronWorkflow, n int) []string {
	schedules := cron.Spec.Schedules
	var times []time.Time
	for _, expr := range schedules {
		if cron.Spec.Timezone != "" {
			expr = "CRON_TZ=" + cron.Spec.Timezone + " " + expr
		}
		sched, err := robfig.ParseStandard(expr)
		if err != nil {
			continue
		}
		at := time.Now()
		for i := 0; i < n; i++ {
			at = sched.Next(at)
			if at.IsZero() {
				break
			}
			times = append(times, at)
		}
	}
	sort.Slice(times, func(i, j int) bool { return times[i].Before(times[j]) })
	if len(times) > n {
		times = times[:n]
	}
	out := make([]string, 0, len(times))
	for _, t := range times {
		out = append(out, t.Format(timeFormat))
	}
	return out
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
