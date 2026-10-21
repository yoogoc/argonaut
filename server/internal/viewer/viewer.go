package viewer

import "context"

// UserViewer is the authenticated caller, resolved once by the OIDC middleware and read by every
// layer below it. Subject is the OIDC `sub`: the stable identity all authz grants are keyed on.
type UserViewer struct {
	Subject       string
	Email         string
	EmailVerified bool
	Name          string
	// Jwt is the raw bearer token, kept for downstream calls that need to re-present it.
	Jwt string
}

// DisplayName prefers a human-readable label but never returns empty.
func (u *UserViewer) DisplayName() string {
	if u == nil {
		return ""
	}
	if u.Name != "" {
		return u.Name
	}
	if u.Email != "" {
		return u.Email
	}
	return u.Subject
}

type ctxUserKey struct{}

func UserFromContext(ctx context.Context) (*UserViewer, bool) {
	v, b := ctx.Value(ctxUserKey{}).(*UserViewer)
	return v, b
}

func NewUserContext(parent context.Context, v *UserViewer) context.Context {
	return context.WithValue(parent, ctxUserKey{}, v)
}

// Subject returns the caller's OIDC subject, or "" when unauthenticated.
func Subject(ctx context.Context) string {
	if v, ok := UserFromContext(ctx); ok {
		return v.Subject
	}
	return ""
}
