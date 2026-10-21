package service

import "github.com/google/wire"

// ProviderSet is the service providers.
var ProviderSet = wire.NewSet(
	NewOauth2Service,
	NewWorkflowService,
	NewWorkflowTemplateService,
	NewCronWorkflowService,
	NewAuthzService,
	NewInfoService,
	NewArtifactHandler,
)

// timeFormat is the wire format for timestamps the UI renders. RFC3339 keeps them unambiguous and
// directly parseable by the browser.
const timeFormat = "2006-01-02T15:04:05Z07:00"
