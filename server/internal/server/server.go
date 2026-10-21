package server

import "github.com/google/wire"

// ProviderSet is the server providers. argonaut exposes HTTP only: the UI is the sole client, and the
// streaming endpoints are Server-Sent Events rather than gRPC streams.
var ProviderSet = wire.NewSet(NewHTTPServer)
