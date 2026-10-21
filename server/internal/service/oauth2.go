package service

import (
	"context"
	"crypto/tls"
	"log/slog"
	"net/http"
	"time"

	v1 "argonaut/api/v1"
	"argonaut/internal/authz"
	"argonaut/internal/conf"
	xoidc "argonaut/internal/oidc"
	"argonaut/internal/viewer"

	bigcachelib "github.com/allegro/bigcache/v3"
	"github.com/go-kratos/kratos/v3/errors"
	"github.com/google/uuid"
	"golang.org/x/oauth2"
	"google.golang.org/protobuf/types/known/emptypb"
)

// stateTTL bounds how long a login may take. The state entry is what ties a callback back to the
// page the user started from, and it is single-use.
const stateTTL = 10 * time.Minute

// Oauth2Service implements the OIDC authorization-code flow. The provider's id_token never reaches
// the browser: it is verified here once, and the browser gets a token argonaut signed itself, so
// session lifetime and contents are ours.
type Oauth2Service struct {
	v1.UnimplementedOauth2ServiceServer

	log       *slog.Logger
	states    *bigcachelib.BigCache
	discovery *xoidc.Discovery
	sso       *conf.SSO
	signer    *xoidc.Signer
	engine    *authz.Engine
}

func NewOauth2Service(
	logger *slog.Logger,
	discovery *xoidc.Discovery,
	ssoConfig *conf.SSO,
	signer *xoidc.Signer,
	engine *authz.Engine,
) (*Oauth2Service, error) {
	states, err := bigcachelib.New(context.Background(), bigcachelib.DefaultConfig(stateTTL))
	if err != nil {
		return nil, err
	}
	return &Oauth2Service{
		log:       logger.With("module", "service/oauth2"),
		states:    states,
		discovery: discovery,
		sso:       ssoConfig,
		signer:    signer,
		engine:    engine,
	}, nil
}

// Redirect starts a login, remembering where to send the user back to.
func (s *Oauth2Service) Redirect(ctx context.Context, req *v1.Oauth2RedirectRequest) (*v1.Oauth2RedirectReply, error) {
	config, err := s.discovery.Config(ctx)
	if err != nil {
		s.log.Error("OIDC discovery failed", "err", err)
		return nil, errors.ServiceUnavailable("sso_unavailable", "the identity provider is not reachable")
	}
	state := uuid.NewString()
	if err := s.states.Set(state, []byte(req.GetRedirect())); err != nil {
		return nil, err
	}
	redirectOption := oauth2.SetAuthURLParam("redirect_uri", s.sso.GetRedirectUrl())
	return &v1.Oauth2RedirectReply{RedirectUri: config.AuthCodeURL(state, redirectOption)}, nil
}

// Callback exchanges the authorization code and issues the session token.
func (s *Oauth2Service) Callback(ctx context.Context, req *v1.Oauth2CallbackRequest) (*v1.Oauth2CallbackReply, error) {
	config, err := s.discovery.Config(ctx)
	if err != nil {
		s.log.Error("OIDC discovery failed", "err", err)
		return nil, errors.ServiceUnavailable("sso_unavailable", "the identity provider is not reachable")
	}
	verifier, err := s.discovery.Verifier(ctx)
	if err != nil {
		return nil, errors.ServiceUnavailable("sso_unavailable", "the identity provider is not reachable")
	}

	// An unknown state means the login did not start here (or took too long), so refuse it rather
	// than completing a flow we cannot correlate. Deleting it makes the state single-use, which stops
	// a captured callback URL from being replayed.
	redirect, err := s.states.Get(req.GetState())
	if err != nil {
		return nil, errors.Unauthorized("invalid_state", "login state is unknown or expired")
	}
	_ = s.states.Delete(req.GetState())

	redirectOption := oauth2.SetAuthURLParam("redirect_uri", s.sso.GetRedirectUrl())
	ctx = context.WithValue(ctx, oauth2.HTTPClient, &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		Proxy:           http.ProxyFromEnvironment,
	}})

	token, err := config.Exchange(ctx, req.GetCode(), redirectOption)
	if err != nil {
		s.log.Error("authorization code exchange failed", "err", err)
		return nil, errors.Unauthorized("exchange_failed", "could not exchange authorization code")
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok {
		return nil, errors.Unauthorized("no_id_token", "provider returned no id_token")
	}
	idToken, err := verifier.Verify(ctx, rawIDToken)
	if err != nil {
		s.log.Error("id_token verification failed", "err", err)
		return nil, errors.Unauthorized("invalid_id_token", "id_token verification failed")
	}

	claims := &xoidc.Claims{}
	if err := idToken.Claims(claims); err != nil {
		return nil, errors.Unauthorized("invalid_claims", err.Error())
	}
	if claims.Subject == "" {
		// Every grant is keyed on `sub`; without it there is no identity to authorize.
		return nil, errors.Unauthorized("invalid_claims", "id_token has no subject")
	}

	session, err := s.signer.Sign(&xoidc.Claims{
		RegisteredClaims: jwtSubject(claims.Subject),
		Email:            claims.Email,
		EmailVerified:    claims.EmailVerified,
		Name:             claims.DisplayName(),
	})
	if err != nil {
		return nil, err
	}

	s.log.Info("login succeeded", "subject", claims.Subject, "email", claims.Email)
	return &v1.Oauth2CallbackReply{
		Authorization: session,
		RedirectUri:   string(redirect),
	}, nil
}

// UserInfo echoes the caller's identity, and whether they are a bootstrapped super admin so the UI
// can show the administration section.
func (s *Oauth2Service) UserInfo(ctx context.Context, _ *emptypb.Empty) (*v1.Oauth2UserInfoReply, error) {
	user, ok := viewer.UserFromContext(ctx)
	if !ok {
		return nil, errors.Unauthorized("unauthorized", "not authenticated")
	}
	return &v1.Oauth2UserInfoReply{
		Issuer:        s.sso.GetIssuer(),
		Subject:       user.Subject,
		Email:         user.Email,
		EmailVerified: user.EmailVerified,
		Name:          user.DisplayName(),
		SuperAdmin:    s.engine.IsSuperAdmin(user.Subject),
	}, nil
}
