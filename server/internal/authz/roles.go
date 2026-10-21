// Package authz decides what a user may do. Decisions are made by OPA evaluating a rego policy
// over the grant table; nothing in the service layer hard-codes permission logic.
package authz

import "strings"

// Action is a "<resource>:<verb>" permission string. The policy matches these literally, so the
// constants here are the complete vocabulary the rego roles refer to.
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
// simple and means the UI can explain exactly what a grant allows.
const (
	RoleViewer   = "viewer"
	RoleOperator = "operator"
	RoleEditor   = "editor"
	RoleAdmin    = "admin"
)

// Resource types a grant can be scoped to.
const (
	ResourceTemplate = "template"
	ResourceGlobal   = "global"
)

// SubjectType values. Only users exist today because the identity provider is undecided and no
// groups claim is consumed; the column and this constant leave room for group grants later.
const (
	SubjectUser  = "user"
	SubjectGroup = "group"
)

// Wildcard matches every template within a namespace.
const Wildcard = "*"

var (
	viewerActions = []Action{
		TemplateGet, TemplateList,
		WorkflowGet, WorkflowList, WorkflowLogs, WorkflowArtifacts, WorkflowEvents,
		CronGet, CronList,
	}
	operatorActions = append(viewerActions,
		WorkflowSubmit, WorkflowRetry, WorkflowResubmit, WorkflowSuspend, WorkflowResume,
		WorkflowSet, WorkflowStop, WorkflowTerminate, WorkflowDelete,
		CronSuspend, CronResume, CronRun,
	)
	editorActions = append(operatorActions,
		TemplateCreate, TemplateUpdate, TemplateDelete,
		CronCreate, CronUpdate, CronDelete,
	)
	adminActions = append(editorActions, AuthzGrant, AuthzRevoke)
)

// Role describes a built-in role for the UI.
type Role struct {
	Name        string
	Actions     []Action
	Description string
}

// Roles returns the built-in roles, narrowest first.
func Roles() []Role {
	return []Role{
		{RoleViewer, viewerActions, "Read templates, workflows, logs and artifacts"},
		{RoleOperator, operatorActions, "Everything a viewer can do, plus submitting and controlling workflow runs"},
		{RoleEditor, editorActions, "Everything an operator can do, plus creating and editing templates and cron workflows"},
		{RoleAdmin, adminActions, "Everything an editor can do, plus granting and revoking permissions on this scope"},
	}
}

// IsRole reports whether name is a built-in role.
func IsRole(name string) bool {
	for _, r := range Roles() {
		if r.Name == name {
			return true
		}
	}
	return false
}

// roleData renders the role table in the shape the rego policy indexes: role name to action strings.
func roleData() map[string][]string {
	data := make(map[string][]string, 4)
	for _, r := range Roles() {
		actions := make([]string, 0, len(r.Actions))
		for _, a := range r.Actions {
			actions = append(actions, string(a))
		}
		data[r.Name] = actions
	}
	return data
}

// normalizeSubject accepts the "user:<sub>" form used in configuration and returns the bare
// subject, so the policy only ever compares raw identifiers.
func normalizeSubject(s string) string {
	if rest, ok := strings.CutPrefix(s, SubjectUser+":"); ok {
		return rest
	}
	return s
}
