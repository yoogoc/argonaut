package argonaut.authz

# Authorization is a single question: may `input.subject` perform `input.action` on
# `input.resource`? Everything is denied unless a rule below says otherwise.
#
# input:  {"subject": "<oidc sub>", "action": "workflow:retry",
#          "resource": {"namespace": "argo", "template": "my-template"}}
# data:   {"grants": [...], "roles": {"viewer": ["..."]}, "super_admins": ["..."]}

default allow := false

# Super admins come from configuration and bypass the grant table. Without them nobody could
# create the very first grant.
allow if input.subject in data.super_admins

# Everyone else needs a grant whose role contains the action and whose scope covers the resource.
allow if {
	some grant in data.grants
	grant.subject == input.subject
	scope_matches(grant)
	input.action in data.roles[grant.role]
}

# A global grant covers every namespace and template.
scope_matches(grant) if grant.resource_type == "global"

# A namespace-wide grant covers every template in that namespace, including workflows that were
# not created from any template.
scope_matches(grant) if {
	grant.resource_type == "template"
	grant.namespace == input.resource.namespace
	grant.name == "*"
}

# A grant on one template covers exactly that template.
scope_matches(grant) if {
	grant.resource_type == "template"
	grant.namespace == input.resource.namespace
	grant.name == input.resource.template
}

# effective_roles powers the "my permissions" view: the roles the subject holds on this resource.
effective_roles contains grant.role if {
	some grant in data.grants
	grant.subject == input.subject
	scope_matches(grant)
}
