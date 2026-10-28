package service

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"

	v1 "argonaut/api/v1"
	"argonaut/internal/biz"
	pkgargo "argonaut/pkg/argo"

	workflowpkg "github.com/argoproj/argo-workflows/v4/pkg/apiclient/workflow"
	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	corev1 "k8s.io/api/core/v1"
)

// WorkflowService maps the HTTP contract onto the workflow usecase. Streaming methods are served as
// Server-Sent Events by Kratos, generated from the `stream` keyword in the proto.
type WorkflowService struct {
	v1.UnimplementedWorkflowServiceServer

	log *slog.Logger
	uc  *biz.WorkflowUsecase
}

func NewWorkflowService(uc *biz.WorkflowUsecase, logger *slog.Logger) *WorkflowService {
	return &WorkflowService{log: logger.With("module", "service/workflow"), uc: uc}
}

func (s *WorkflowService) List(ctx context.Context, req *v1.ListWorkflowRequest) (*v1.ListWorkflowReply, error) {
	list, err := s.uc.List(ctx, pkgargo.ListOptions{
		Namespace:     req.GetNamespace(),
		LabelSelector: req.GetLabelSelector(),
		NamePattern:   req.GetNamePattern(),
		Phases:        req.GetPhases(),
		Parameters:    req.GetParameters(),
		Templates:     req.GetTemplates(),
		Limit:         req.GetLimit(),
		ContinueToken: req.GetContinueToken(),
	})
	if err != nil {
		return nil, err
	}
	return &v1.ListWorkflowReply{List: list}, nil
}

func (s *WorkflowService) Get(ctx context.Context, req *v1.GetWorkflowRequest) (*v1.WorkflowReply, error) {
	wf, err := s.uc.Get(ctx, req.GetNamespace(), req.GetName(), req.GetFields())
	if err != nil {
		return nil, err
	}
	return &v1.WorkflowReply{Workflow: wf}, nil
}

// Watch streams status updates. The workflow is sent as pre-serialized JSON because protojson
// rejects Argo's custom scalar types (EstimatedDuration and friends) inside the SSE encoder.
func (s *WorkflowService) Watch(req *v1.WatchWorkflowRequest, stream v1.WorkflowService_WatchServer) error {
	ctx := stream.Context()
	send := sendOrStop(ctx, stream.Send)
	err := s.uc.Watch(ctx, req.GetNamespace(), req.GetName(), req.GetLabelSelector(), req.GetFields(), func(event *workflowpkg.WorkflowWatchEvent) error {
		payload := ""
		if event.Object != nil {
			raw, err := json.Marshal(event.Object)
			if err != nil {
				return err
			}
			payload = string(raw)
		}
		return send(&v1.WorkflowWatchEvent{Type: event.Type, WorkflowJson: payload})
	})
	return finishStream(ctx, err)
}

func (s *WorkflowService) Events(req *v1.WorkflowEventsRequest, stream v1.WorkflowService_EventsServer) error {
	ctx := stream.Context()
	send := sendOrStop(ctx, stream.Send)
	err := s.uc.Events(ctx, req.GetNamespace(), req.GetName(), func(event *corev1.Event) error {
		return send(&v1.WorkflowEvent{
			Type:           event.Type,
			Reason:         event.Reason,
			Message:        event.Message,
			ObjectName:     event.InvolvedObject.Name,
			ObjectKind:     event.InvolvedObject.Kind,
			FirstTimestamp: event.FirstTimestamp.UTC().Format(timeFormat),
			LastTimestamp:  event.LastTimestamp.UTC().Format(timeFormat),
			Count:          event.Count,
		})
	})
	return finishStream(ctx, err)
}

func (s *WorkflowService) Logs(req *v1.WorkflowLogRequest, stream v1.WorkflowService_LogsServer) error {
	logOptions := &corev1.PodLogOptions{
		Container:  req.GetContainer(),
		Follow:     req.GetFollow(),
		Timestamps: req.GetTimestamps(),
	}
	if logOptions.Container == "" {
		// "main" is the user's container; Argo's own UI defaults to it rather than the init or wait
		// sidecars, which carry no useful output.
		logOptions.Container = "main"
	}
	if tail := req.GetTailLines(); tail > 0 {
		logOptions.TailLines = &tail
	}

	ctx := stream.Context()
	send := sendOrStop(ctx, stream.Send)
	err := s.uc.Logs(ctx, req.GetNamespace(), req.GetName(), req.GetNodeId(), &workflowpkg.WorkflowLogRequest{
		PodName:    req.GetPodName(),
		LogOptions: logOptions,
		Grep:       req.GetGrep(),
	}, func(entry *workflowpkg.LogEntry) error {
		return send(&v1.WorkflowLogEntry{Content: entry.Content, PodName: entry.PodName})
	})
	return finishStream(ctx, err)
}

func (s *WorkflowService) Submit(ctx context.Context, req *v1.SubmitWorkflowRequest) (*v1.WorkflowReply, error) {
	opts := &wfv1.SubmitOpts{
		Entrypoint:     req.GetEntryPoint(),
		Parameters:     req.GetParameters(),
		Labels:         strings.Join(req.GetLabels(), ","),
		GenerateName:   req.GetGenerateName(),
		ServiceAccount: req.GetServiceAccount(),
		// SubmitOpts.DryRun is a client-side CLI flag Argo ignores over the API; ServerDryRun is the
		// one that makes the server validate without creating.
		ServerDryRun: req.GetDryRun(),
	}
	wf, err := s.uc.Submit(ctx, req.GetNamespace(), req.GetResourceKind(), req.GetResourceName(), opts)
	if err != nil {
		return nil, err
	}
	return &v1.WorkflowReply{Workflow: wf}, nil
}

func (s *WorkflowService) Create(ctx context.Context, req *v1.CreateWorkflowRequest) (*v1.WorkflowReply, error) {
	wf, err := parseWorkflow(req.GetManifest())
	if err != nil {
		return nil, err
	}
	created, err := s.uc.Create(ctx, req.GetNamespace(), wf, req.GetDryRun())
	if err != nil {
		return nil, err
	}
	return &v1.WorkflowReply{Workflow: created}, nil
}

func (s *WorkflowService) Lint(ctx context.Context, req *v1.LintWorkflowRequest) (*v1.WorkflowReply, error) {
	wf, err := parseWorkflow(req.GetManifest())
	if err != nil {
		return nil, err
	}
	linted, err := s.uc.Lint(ctx, req.GetNamespace(), wf)
	if err != nil {
		return nil, err
	}
	return &v1.WorkflowReply{Workflow: linted}, nil
}

func (s *WorkflowService) Retry(ctx context.Context, req *v1.RetryWorkflowRequest) (*v1.WorkflowReply, error) {
	wf, err := s.uc.Retry(ctx, req.GetNamespace(), req.GetName(), req.GetRestartSuccessful(), req.GetNodeFieldSelector(), req.GetParameters())
	if err != nil {
		return nil, err
	}
	return &v1.WorkflowReply{Workflow: wf}, nil
}

func (s *WorkflowService) Resubmit(ctx context.Context, req *v1.ResubmitWorkflowRequest) (*v1.WorkflowReply, error) {
	wf, err := s.uc.Resubmit(ctx, req.GetNamespace(), req.GetName(), req.GetMemoized(), req.GetParameters())
	if err != nil {
		return nil, err
	}
	return &v1.WorkflowReply{Workflow: wf}, nil
}

func (s *WorkflowService) Suspend(ctx context.Context, req *v1.WorkflowActionRequest) (*v1.WorkflowReply, error) {
	wf, err := s.uc.Suspend(ctx, req.GetNamespace(), req.GetName())
	if err != nil {
		return nil, err
	}
	return &v1.WorkflowReply{Workflow: wf}, nil
}

func (s *WorkflowService) Resume(ctx context.Context, req *v1.ResumeWorkflowRequest) (*v1.WorkflowReply, error) {
	wf, err := s.uc.Resume(ctx, req.GetNamespace(), req.GetName(), req.GetNodeFieldSelector())
	if err != nil {
		return nil, err
	}
	return &v1.WorkflowReply{Workflow: wf}, nil
}

func (s *WorkflowService) Set(ctx context.Context, req *v1.SetWorkflowRequest) (*v1.WorkflowReply, error) {
	wf, err := s.uc.Set(ctx, req.GetNamespace(), req.GetName(), req.GetNodeFieldSelector(), req.GetOutputParameters(), req.GetPhase(), req.GetMessage())
	if err != nil {
		return nil, err
	}
	return &v1.WorkflowReply{Workflow: wf}, nil
}

func (s *WorkflowService) Stop(ctx context.Context, req *v1.StopWorkflowRequest) (*v1.WorkflowReply, error) {
	wf, err := s.uc.Stop(ctx, req.GetNamespace(), req.GetName(), req.GetNodeFieldSelector(), req.GetMessage())
	if err != nil {
		return nil, err
	}
	return &v1.WorkflowReply{Workflow: wf}, nil
}

func (s *WorkflowService) Terminate(ctx context.Context, req *v1.WorkflowActionRequest) (*v1.WorkflowReply, error) {
	wf, err := s.uc.Terminate(ctx, req.GetNamespace(), req.GetName())
	if err != nil {
		return nil, err
	}
	return &v1.WorkflowReply{Workflow: wf}, nil
}

func (s *WorkflowService) Delete(ctx context.Context, req *v1.DeleteWorkflowRequest) (*v1.DeleteWorkflowReply, error) {
	if err := s.uc.Delete(ctx, req.GetNamespace(), req.GetName(), req.GetForce()); err != nil {
		return nil, err
	}
	return &v1.DeleteWorkflowReply{}, nil
}

func (s *WorkflowService) RenderedTemplate(ctx context.Context, req *v1.RenderedTemplateRequest) (*v1.RenderedTemplateReply, error) {
	out, err := s.uc.RenderedTemplate(ctx, req.GetNamespace(), req.GetName(), req.GetNodeId())
	if err != nil {
		return nil, err
	}
	return &v1.RenderedTemplateReply{PodName: out.PodName, TemplateJson: out.JSON}, nil
}

func (s *WorkflowService) EvaluateExpressions(ctx context.Context, req *v1.EvaluateExpressionsRequest) (*v1.EvaluateExpressionsReply, error) {
	results, err := s.uc.EvaluateExpressions(ctx, req.GetExpressions(), req.GetVariables())
	if err != nil {
		return nil, err
	}
	reply := &v1.EvaluateExpressionsReply{Results: make([]*v1.EvaluatedExpression, len(results))}
	for i, r := range results {
		reply.Results[i] = &v1.EvaluatedExpression{Value: r.Value, Error: r.Error}
	}
	return reply, nil
}
