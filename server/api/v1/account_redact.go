package v1

// Kratos logs request arguments via Redact. Keep the setup token out of logs.
func (*SetupAdminRequest) Redact() string { return "[setup credentials redacted]" }
