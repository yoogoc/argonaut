package conf

// DevelopmentSubject returns the identity to use for requests when SSO is disabled.
func DevelopmentSubject(sso *SSO, authz *Authz) string {
	if sso.GetEnabled() {
		return ""
	}
	if subject := authz.GetDevSubject(); subject != "" {
		return subject
	}
	return "developer"
}
