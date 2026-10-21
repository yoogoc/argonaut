package biz

import "github.com/google/wire"

// ProviderSet is the biz providers.
var ProviderSet = wire.NewSet(
	NewAuthzUsecase,
	NewWorkflowUsecase,
	NewTemplateUsecase,
	NewCronUsecase,
)
