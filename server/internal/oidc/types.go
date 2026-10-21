package oidc

import "github.com/golang-jwt/jwt/v5"

// Claims is the subset of OIDC claims argonaut relies on. The identity provider is deliberately not
// fixed, so this sticks to claims every compliant provider issues. In particular there is no
// `groups` claim: authorization subjects are individual users keyed by `sub`.
//
// The same struct is reused for the token argonaut signs itself after a successful login, so the
// browser session carries exactly the identity the IdP asserted and nothing more.
type Claims struct {
	jwt.RegisteredClaims
	Email         string `json:"email,omitempty"`
	EmailVerified bool   `json:"email_verified,omitempty"`
	Name          string `json:"name,omitempty"`
	// PreferredUsername is a display fallback when `name` is absent.
	PreferredUsername string `json:"preferred_username,omitempty"`
}

// DisplayName picks the best human-readable label the provider gave us.
func (c *Claims) DisplayName() string {
	switch {
	case c.Name != "":
		return c.Name
	case c.PreferredUsername != "":
		return c.PreferredUsername
	case c.Email != "":
		return c.Email
	default:
		return c.Subject
	}
}
