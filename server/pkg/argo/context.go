package argo

import (
	"context"

	"github.com/argoproj/argo-workflows/v4/server/auth"
	authtypes "github.com/argoproj/argo-workflows/v4/server/auth/types"
	"github.com/argoproj/argo-workflows/v4/util/logging"
	"github.com/go-jose/go-jose/v4/jwt"
)

// Argo's server packages take their Kubernetes clients from the request context, which argo-server's
// gatekeeper populates per request after authenticating the caller. argonaut authenticates with OIDC
// and authorizes with OPA before ever reaching Argo, and always talks to the cluster as the platform
// ServiceAccount — so we just inject those shared clients.
//
// Every context handed to an Argo server must pass through WithClients, otherwise Argo's
// auth.GetWfClient panics on the missing context value. A Kratos middleware does this globally.

// WithClients puts everything Argo's server packages read off the context: the platform Kubernetes
// clients, and — since v4 — a logger.
//
// The logger is not optional. v4's servers call logging.RequireLoggerFromContext, which panics rather
// than falling back, so a context without one fails at the first request instead of at compile time.
// Injecting it here, in the single place every Argo call passes through, is what keeps that from
// depending on each call site remembering.
func WithClients(ctx context.Context, clients *Clients) context.Context {
	ctx = context.WithValue(ctx, auth.DynamicKey, clients.Dynamic)
	ctx = context.WithValue(ctx, auth.WfKey, clients.Workflow)
	ctx = context.WithValue(ctx, auth.KubeKey, clients.Kubernetes)
	if logging.GetLoggerFromContextOrNil(ctx) == nil {
		ctx = logging.WithLogger(ctx, logging.NewSlogLogger(logging.Info, logging.JSON))
	}
	if auth.GetClaims(ctx) == nil {
		ctx = context.WithValue(ctx, auth.ClaimsKey, &authtypes.Claims{})
	}
	return ctx
}

// WithSubject records the authenticated argonaut user on the context. Argo uses these claims only for
// logging and for the creator labels it stamps on submitted workflows; access control stays ours.
func WithSubject(ctx context.Context, subject, email, name string) context.Context {
	return context.WithValue(ctx, auth.ClaimsKey, &authtypes.Claims{
		Claims: jwt.Claims{Subject: subject},
		Email:  email,
		Name:   name,
	})
}
