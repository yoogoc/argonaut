package main

import (
	"context"
	"os/signal"
	"syscall"
)

// NewAppContext is the lifetime of the process, used by components that start background work at
// construction (the workflow template informer, the grant reloader). Cancelling it on a termination
// signal stops those watches instead of leaving them running while the server drains.
func NewAppContext() (context.Context, func()) {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	return ctx, stop
}
