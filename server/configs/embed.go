package configs

import "embed"

// DefaultFS holds the shipped defaults, compiled into the binary. Local overrides in configs/local,
// an explicit --config path and ARGONAUT_ environment variables are layered on top (cmd/main.go).
//
//go:embed default
var DefaultFS embed.FS
