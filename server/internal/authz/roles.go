// Package authz decides what a user may do. Decisions are made by Cedar policies over the grant
// table (DESIGN §4.2); nothing in the service layer hard-codes permission logic.
package authz

import "strings"

// Action is a "<resource>:<verb>" permission string, used verbatim as the Cedar action id.
type Action string

const (
	TemplateGet    Action = "template:get"
	TemplateList   Action = "template:list"
	TemplateCreate Action = "template:create"
	TemplateUpdate Action = "template:update"
	TemplateDelete Action = "template:delete"

	WorkflowGet       Action = "workflow:get"
	WorkflowList      Action = "workflow:list"
	WorkflowLogs      Action = "workflow:logs"
	WorkflowArtifacts Action = "workflow:artifacts"
	WorkflowEvents    Action = "workflow:events"
	WorkflowSubmit    Action = "workflow:submit"
	WorkflowRetry     Action = "workflow:retry"
	WorkflowResubmit  Action = "workflow:resubmit"
	WorkflowSuspend   Action = "workflow:suspend"
	WorkflowResume    Action = "workflow:resume"
	WorkflowSet       Action = "workflow:set"
	WorkflowStop      Action = "workflow:stop"
	WorkflowTerminate Action = "workflow:terminate"
	WorkflowDelete    Action = "workflow:delete"

	CronGet     Action = "cron:get"
	CronList    Action = "cron:list"
	CronCreate  Action = "cron:create"
	CronUpdate  Action = "cron:update"
	CronDelete  Action = "cron:delete"
	CronSuspend Action = "cron:suspend"
	CronResume  Action = "cron:resume"
	CronRun     Action = "cron:run"

	// AuthzGrant is the permission to hand out permissions on a resource scope.
	AuthzGrant  Action = "authz:grant"
	AuthzRevoke Action = "authz:revoke"
)

// Role names. Roles are fixed rather than user-definable: a small closed set keeps the mental model
// simple and means the UI can explain exactly what a grant allows. Finer rules are written as custom
// Cedar policies instead.
const (
	RoleViewer   = "viewer"
	RoleOperator = "operator"
	RoleEditor   = "editor"
	RoleAdmin    = "admin"
)

// Resource types a grant can be scoped to.
const (
	ResourceGlobal          = "global"
	ResourceNamespace       = "namespace"
	ResourceTemplate        = "template"
	ResourceClusterTemplate = "cluster_template"
)

// SubjectType values. Only users exist in the first version (DESIGN §8); the column leaves room for
// group grants.
const (
	SubjectUser  = "user"
	SubjectGroup = "group"
)

// Wildcard is the name of a namespace-wide grant in older rows and request bodies.
const Wildcard = "*"

var (
	viewerActions = []Action{
		TemplateGet, TemplateList,
		WorkflowGet, WorkflowList, WorkflowLogs, WorkflowArtifacts, WorkflowEvents,
		CronGet, CronList,
	}
	operatorOnly = []Action{
		WorkflowSubmit, WorkflowRetry, WorkflowResubmit, WorkflowSuspend, WorkflowResume,
		WorkflowSet, WorkflowStop, WorkflowTerminate, WorkflowDelete,
		CronSuspend, CronResume, CronRun,
	}
	editorOnly = []Action{
		TemplateCreate, TemplateUpdate, TemplateDelete,
		CronCreate, CronUpdate, CronDelete,
	}
	adminOnly = []Action{AuthzGrant, AuthzRevoke}
)

// roleOrder lists roles narrowest first; each includes everything before it.
var roleOrder = []string{RoleViewer, RoleOperator, RoleEditor, RoleAdmin}

// ownActions are the actions a role adds over the role below it.
var ownActions = map[string][]Action{
	RoleViewer:   viewerActions,
	RoleOperator: operatorOnly,
	RoleEditor:   editorOnly,
	RoleAdmin:    adminOnly,
}

// AllActions is the complete vocabulary, in role order.
func AllActions() []Action {
	var out []Action
	for _, role := range roleOrder {
		out = append(out, ownActions[role]...)
	}
	return out
}

// Role describes a built-in role for the UI.
type Role struct {
	Name        string
	Actions     []Action
	Description string
}

// Roles returns the built-in roles, narrowest first, each with its full (inherited) action list.
func Roles() []Role {
	descriptions := map[string]string{
		RoleViewer:   "Read templates, workflows, logs, artifacts and events",
		RoleOperator: "Everything a viewer can do, plus submitting and controlling workflow runs",
		RoleEditor:   "Everything an operator can do, plus creating and editing templates and cron workflows",
		RoleAdmin:    "Everything an editor can do, plus granting and revoking permissions on this scope",
	}
	out := make([]Role, 0, len(roleOrder))
	var acc []Action
	for _, name := range roleOrder {
		acc = append(acc, ownActions[name]...)
		out = append(out, Role{Name: name, Actions: append([]Action(nil), acc...), Description: descriptions[name]})
	}
	return out
}

// IsRole reports whether name is a built-in role.
func IsRole(name string) bool {
	for _, r := range roleOrder {
		if r == name {
			return true
		}
	}
	return false
}

// normalizeSubject accepts the "user:<sub>" form used in configuration and returns the bare subject.
func normalizeSubject(s string) string {
	if rest, ok := strings.CutPrefix(s, SubjectUser+":"); ok {
		return rest
	}
	return s
}
