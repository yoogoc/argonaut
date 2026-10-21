package argo

import (
	"context"

	workflowpkg "github.com/argoproj/argo-workflows/v4/pkg/apiclient/workflow"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	corev1 "k8s.io/api/core/v1"
)

// Argo's server methods are gRPC handlers: streaming calls push into a grpc.ServerStream. We call
// them in-process, so these adapters present a callback as that stream. Each Send is forwarded to
// the callback (which writes a Kratos SSE frame); returning an error from the callback aborts the
// Argo handler, which is how a disconnected browser stops the underlying Kubernetes watch.

// serverStream is the no-op grpc.ServerStream half of the adapters. Argo never reads headers or
// receives messages on these streams, so only Context has to do anything real.
type serverStream struct {
	ctx context.Context
}

func (s *serverStream) SetHeader(metadata.MD) error  { return nil }
func (s *serverStream) SendHeader(metadata.MD) error { return nil }
func (s *serverStream) SetTrailer(metadata.MD)       {}
func (s *serverStream) Context() context.Context     { return s.ctx }
func (s *serverStream) SendMsg(any) error            { return nil }
func (s *serverStream) RecvMsg(any) error            { return nil }

// WatchStream adapts WatchWorkflows to a callback.
type WatchStream struct {
	serverStream
	send func(*workflowpkg.WorkflowWatchEvent) error
}

var _ workflowpkg.WorkflowService_WatchWorkflowsServer = &WatchStream{}

func NewWatchStream(ctx context.Context, send func(*workflowpkg.WorkflowWatchEvent) error) *WatchStream {
	return &WatchStream{serverStream: serverStream{ctx: ctx}, send: send}
}

func (s *WatchStream) Send(e *workflowpkg.WorkflowWatchEvent) error { return s.send(e) }

// EventStream adapts WatchEvents (Kubernetes events for a workflow) to a callback.
type EventStream struct {
	serverStream
	send func(*corev1.Event) error
}

var _ workflowpkg.WorkflowService_WatchEventsServer = &EventStream{}

func NewEventStream(ctx context.Context, send func(*corev1.Event) error) *EventStream {
	return &EventStream{serverStream: serverStream{ctx: ctx}, send: send}
}

func (s *EventStream) Send(e *corev1.Event) error { return s.send(e) }

// LogStream adapts PodLogs / WorkflowLogs to a callback.
type LogStream struct {
	serverStream
	send func(*workflowpkg.LogEntry) error
}

var (
	_ workflowpkg.WorkflowService_PodLogsServer      = &LogStream{}
	_ workflowpkg.WorkflowService_WorkflowLogsServer = &LogStream{}
)

func NewLogStream(ctx context.Context, send func(*workflowpkg.LogEntry) error) *LogStream {
	return &LogStream{serverStream: serverStream{ctx: ctx}, send: send}
}

func (s *LogStream) Send(e *workflowpkg.LogEntry) error { return s.send(e) }

// Assert the adapters really are usable as gRPC streams; a signature drift in Argo should fail the
// build here rather than at the first browser request.
var (
	_ grpc.ServerStream = &WatchStream{}
	_ grpc.ServerStream = &EventStream{}
	_ grpc.ServerStream = &LogStream{}
)
