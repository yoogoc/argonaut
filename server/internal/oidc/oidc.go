package oidc

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"sync"
	"time"

	"argonaut/internal/conf"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/wire"
	"golang.org/x/oauth2"
)

// ProviderSet is the oidc providers.
var ProviderSet = wire.NewSet(
	NewDiscovery,
	NewSigner,
)

const defaultSessionExpiry = 12 * time.Hour

// Discovery resolves the provider's OIDC metadata on first use rather than at startup.
//
// Discovery is a network call to the identity provider. Doing it eagerly would tie the server's
// ability to boot to the IdP being reachable at that instant — which in Kubernetes it often is not,
// because both start together. Resolving lazily (and retrying on the next login attempt) means a
// slow or briefly unavailable IdP delays logins instead of crash-looping the server.
type Discovery struct {
	sso *conf.SSO

	mu       sync.Mutex
	provider *oidc.Provider
}

func NewDiscovery(ssoConfig *conf.SSO) *Discovery {
	return &Discovery{sso: ssoConfig}
}

// Enabled reports whether single sign-on is configured.
func (d *Discovery) Enabled() bool {
	return d.sso.GetEnabled()
}

// provide performs discovery once and caches the result. A failure is not cached, so the next
// request retries.
func (d *Discovery) provide(ctx context.Context) (*oidc.Provider, error) {
	if !d.sso.GetEnabled() {
		return nil, fmt.Errorf("single sign-on is not configured")
	}

	d.mu.Lock()
	defer d.mu.Unlock()
	if d.provider != nil {
		return d.provider, nil
	}

	httpClient := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		Proxy:           http.ProxyFromEnvironment,
	}}
	discoveryCtx := oidc.ClientContext(ctx, httpClient)
	// An in-cluster IdP is often reachable at a different URL than the issuer it stamps into tokens;
	// IssuerAlias tells go-oidc to accept that mismatch.
	if alias := d.sso.GetIssuerAlias(); alias != "" {
		discoveryCtx = oidc.InsecureIssuerURLContext(discoveryCtx, alias)
	}

	provider, err := oidc.NewProvider(discoveryCtx, d.sso.GetIssuer())
	if err != nil {
		return nil, fmt.Errorf("discovering OIDC provider %s: %w", d.sso.GetIssuer(), err)
	}
	d.provider = provider
	return provider, nil
}

// Config returns the OAuth2 client configuration.
func (d *Discovery) Config(ctx context.Context) (*oauth2.Config, error) {
	provider, err := d.provide(ctx)
	if err != nil {
		return nil, err
	}
	return &oauth2.Config{
		ClientID:     d.sso.GetClientId(),
		ClientSecret: d.sso.GetClientSecret(),
		RedirectURL:  d.sso.GetRedirectUrl(),
		Endpoint:     provider.Endpoint(),
		// Only standard scopes: profile and email supply the display name. No group scope is
		// requested, because grants are per user.
		Scopes: []string{oidc.ScopeOpenID, "profile", "email"},
	}, nil
}

// Verifier returns the id_token verifier.
func (d *Discovery) Verifier(ctx context.Context) (*oidc.IDTokenVerifier, error) {
	provider, err := d.provide(ctx)
	if err != nil {
		return nil, err
	}
	return provider.Verifier(&oidc.Config{ClientID: d.sso.GetClientId()}), nil
}

// Signer issues and validates the session tokens argonaut hands the browser. The IdP's id_token is
// never given to the UI: it is verified once at callback and re-signed here, so session lifetime
// and payload are ours to control.
type Signer struct {
	secret []byte
	expiry time.Duration
	issuer string
}

func NewSigner(ssoConfig *conf.SSO) *Signer {
	expiry := defaultSessionExpiry
	if d := ssoConfig.GetSessionExpiry(); d != nil && d.AsDuration() > 0 {
		expiry = d.AsDuration()
	}
	return &Signer{
		secret: []byte(ssoConfig.GetJwtSecret()),
		expiry: expiry,
		issuer: ssoConfig.GetIssuer(),
	}
}

// Sign mints a session token for an authenticated subject.
func (s *Signer) Sign(claims *Claims) (string, error) {
	now := time.Now()
	claims.Issuer = s.issuer
	claims.IssuedAt = jwt.NewNumericDate(now)
	claims.ExpiresAt = jwt.NewNumericDate(now.Add(s.expiry))
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.secret)
}

// Parse validates a session token and returns its claims.
func (s *Signer) Parse(token string) (*Claims, error) {
	claims := &Claims{}
	// Pinning the algorithm stops an attacker swapping in "none" or an asymmetric signature.
	_, err := jwt.ParseWithClaims(token, claims, func(*jwt.Token) (any, error) {
		return s.secret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
	if err != nil {
		return nil, err
	}
	return claims, nil
}
