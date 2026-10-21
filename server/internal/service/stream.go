package service

import (
	"context"
	"errors"
	"net"
	"strings"
	"syscall"
)

// A browser closing a Server-Sent Events stream is the normal way these endpoints end: the user
// navigates away, or the component unmounts and aborts the request. The server notices only when it
// next writes, which fails with a broken pipe. That is not a server fault, so it must not surface as
// a 500 — otherwise every closed log view or graph page logs an error and, in a monitored deployment,
// pages someone.

// errClientGone unwinds an Argo stream loop once the client has disconnected. Argo's streaming
// handlers keep going until the send callback returns an error, so an explicit one is needed to stop
// the underlying Kubernetes watch promptly.
var errClientGone = errors.New("client disconnected")

// sendOrStop wraps a stream send so a disconnected client ends the stream instead of failing it.
func sendOrStop[T any](ctx context.Context, send func(T) error) func(T) error {
	return func(message T) error {
		if err := send(message); err != nil {
			if clientGone(ctx, err) {
				return errClientGone
			}
			return err
		}
		return nil
	}
}

// finishStream turns a client disconnect into a clean end of stream, leaving real failures intact.
func finishStream(ctx context.Context, err error) error {
	if err == nil || errors.Is(err, errClientGone) || clientGone(ctx, err) {
		return nil
	}
	return err
}

// clientGone reports whether an error means the client went away.
func clientGone(ctx context.Context, err error) bool {
	if err == nil {
		return false
	}
	// The request context is cancelled when the connection closes, which is the most reliable signal
	// and needs no knowledge of how the write failed.
	if ctx.Err() != nil {
		return true
	}
	if errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, net.ErrClosed) || errors.Is(err, context.Canceled) {
		return true
	}
	// A write can fail just before the cancellation propagates, and Kratos reports it as a gRPC
	// status, which discards the wrapped error — leaving the message as the only remaining signal.
	message := err.Error()
	return strings.Contains(message, "broken pipe") ||
		strings.Contains(message, "connection reset by peer") ||
		strings.Contains(message, "client disconnected")
}
