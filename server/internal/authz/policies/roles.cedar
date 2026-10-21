// Built-in role policies. A grant makes the user a member of a role group on a scope
// (Group::"<scope>#<role>"); every resource lists the groups of each scope that covers it, so one
// policy per role answers "does any of the user's grants cover this resource". Roles nest through the
// action hierarchy (Action::"role:viewer" in Action::"role:operator" in ...), so an operator grant
// also allows everything a viewer may do.

@id("role-viewer")
permit (principal, action in Action::"role:viewer", resource)
when { principal in resource.viewers };

@id("role-operator")
permit (principal, action in Action::"role:operator", resource)
when { principal in resource.operators };

@id("role-editor")
permit (principal, action in Action::"role:editor", resource)
when { principal in resource.editors };

@id("role-admin")
permit (principal, action in Action::"role:admin", resource)
when { principal in resource.admins };

// ClusterWorkflowTemplates are shared building blocks; by default every signed-in user may read them
// (authz.cluster_templates_readable).
@id("cluster-templates-readable")
permit (principal, action in [Action::"template:get", Action::"template:list"], resource is ClusterTemplate)
when { context.clusterTemplatesReadable };
