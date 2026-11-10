package biz

import "github.com/google/wire"

// ProviderSet is the biz providers.
var ProviderSet = wire.NewSet(
	NewAuditor,
	NewAuthzUsecase,
	NewAccounts,
	NewTemplateHistory,
	NewWorkflowUsecase,
	NewArchiveUsecase,
	NewTemplateUsecase,
	NewClusterTemplateUsecase,
	NewCronUsecase,
)
