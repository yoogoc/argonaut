package schema

import (
	"time"

	"argonaut/pkg/id"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Grant is the only business table argonaut owns. Workflows, templates and cron workflows all live in
// Kubernetes as Argo CRDs; this table records nothing but who may do what to them.
type Grant struct {
	ent.Schema
}

func (Grant) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").DefaultFunc(id.Generate),
		// subject_type is "user" today. Group grants need an identity provider decision first, so
		// the column exists to make that a data change rather than a migration.
		field.String("subject_type").Default("user"),
		// subject is the OIDC `sub`, chosen over email because it is stable across profile changes.
		field.String("subject"),
		// resource_type is "template" or "global".
		field.String("resource_type").Default("template"),
		// namespace is empty for global grants.
		field.String("namespace").Default(""),
		// name is a WorkflowTemplate name, or "*" for every template in the namespace.
		field.String("name").Default("*"),
		// role is one of viewer / operator / editor / admin.
		field.String("role"),
		// created_by is the subject that issued this grant, which makes the table an audit trail.
		field.String("created_by").Default(""),
		field.Time("created_at").Immutable().Default(time.Now),
	}
}

func (Grant) Edges() []ent.Edge {
	return nil
}

func (Grant) Indexes() []ent.Index {
	return []ent.Index{
		// The engine reads every grant on reload and the UI filters by subject or scope.
		index.Fields("subject"),
		index.Fields("namespace", "name"),
		// One row per subject-scope-role: re-granting the same thing must not duplicate rows.
		index.Fields("subject_type", "subject", "resource_type", "namespace", "name", "role").Unique(),
	}
}

func (Grant) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "grants"},
	}
}
