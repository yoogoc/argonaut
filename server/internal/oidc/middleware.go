package oidc

import (
	"context"
	"net/http"
	"strings"

	"argonaut/internal/viewer"

	"github.com/go-kratos/kratos/v3/errors"
	"github.com/go-kratos/kratos/v3/middleware"
	"github.com/go-kratos/kratos/v3/transport"
)

// DevAuth injects a fixed identity for local development, where there is no identity provider to log
// in against. It is only wired up when sso.enabled is false and authz.dev_subject is set, and the
// server logs a warning on every startup so this cannot be mistaken for a real configuration.
func DevAuth(subject string) middleware.Middleware {
	return func(handler middleware.Handler) middleware.Handler {
		return func(ctx context.Context, req any) (any, error) {
			return handler(viewer.NewUserContext(ctx, &viewer.UserViewer{
				Subject: subject,
				Name:    subject + " (development)",
			}), req)
		}
	}
}

// Auth validates the session token and resolves the caller once per request. Everything downstream
// (services, authz, Argo calls) reads the identity from the context rather than re-parsing the JWT.
func Auth(signer *Signer) middleware.Middleware {
	return func(handler middleware.Handler) middleware.Handler {
		return func(ctx context.Context, req any) (any, error) {
			tr, ok := transport.FromServerContext(ctx)
			if !ok {
				return nil, errors.Unauthorized("unauthorized", "no transport in context")
			}
			token := bearer(tr.RequestHeader().Get("Authorization"))
			if token == "" {
				return nil, errors.Unauthorized("unauthorized", "missing authorization header")
			}
			claims, err := signer.Parse(token)
			if err != nil {
				return nil, errors.Unauthorized("unauthorized", err.Error())
			}
			if claims.Subject == "" {
				return nil, errors.Unauthorized("unauthorized", "token has no subject")
			}

			ctx = viewer.NewUserContext(ctx, &viewer.UserViewer{
				Subject:       claims.Subject,
				Email:         claims.Email,
				EmailVerified: claims.EmailVerified,
				Name:          claims.DisplayName(),
				Jwt:           token,
			})
			return handler(ctx, req)
		}
	}
}

// UserFromRequest authenticates a plain HTTP request, for handlers that sit outside the Kratos
// middleware chain (artifact downloads).
//
// It also accepts the token from an `authorization` cookie. A browser following a download link
// cannot set request headers, so a header-only scheme would make artifact links unusable; argo-server
// solves it the same way. The cookie is set by the UI after login.
func UserFromRequest(signer *Signer, r *http.Request) (*viewer.UserViewer, error) {
	token := bearer(r.Header.Get("Authorization"))
	if token == "" {
		if cookie, err := r.Cookie("authorization"); err == nil {
			token = bearer(cookie.Value)
		}
	}
	if token == "" {
		return nil, errors.Unauthorized("unauthorized", "missing credentials")
	}
	claims, err := signer.Parse(token)
	if err != nil {
		return nil, errors.Unauthorized("unauthorized", err.Error())
	}
	if claims.Subject == "" {
		return nil, errors.Unauthorized("unauthorized", "token has no subject")
	}
	return &viewer.UserViewer{
		Subject:       claims.Subject,
		Email:         claims.Email,
		EmailVerified: claims.EmailVerified,
		Name:          claims.DisplayName(),
		Jwt:           token,
	}, nil
}

// bearer accepts both "Bearer <token>" and a bare token, since the UI sends the raw value.
func bearer(header string) string {
	if header == "" {
		return ""
	}
	if parts := strings.SplitN(header, " ", 2); len(parts) == 2 && strings.EqualFold(parts[0], "bearer") {
		return strings.TrimSpace(parts[1])
	}
	return strings.TrimSpace(header)
}
