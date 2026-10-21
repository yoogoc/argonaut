package data

import (
	"context"
	"fmt"
	"strconv"

	"argonaut/internal/authz"
	"argonaut/internal/biz"
	"argonaut/internal/data/ent"
	"argonaut/internal/data/ent/grant"
)

type grantRepo struct {
	data *Data
}

// NewGrantRepo returns the grants repository.
func NewGrantRepo(data *Data) biz.GrantRepo {
	return &grantRepo{data: data}
}

func (r *grantRepo) List(ctx context.Context) ([]authz.Grant, error) {
	rows, err := r.data.db.Grant.Query().Order(ent.Asc(grant.FieldCreatedAt)).All(ctx)
	if err != nil {
		return nil, err
	}
	return toGrants(rows), nil
}

func (r *grantRepo) ListBySubject(ctx context.Context, subject string) ([]authz.Grant, error) {
	rows, err := r.data.db.Grant.Query().
		Where(grant.Subject(subject)).
		Order(ent.Asc(grant.FieldCreatedAt)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	return toGrants(rows), nil
}

func (r *grantRepo) Get(ctx context.Context, id string) (authz.Grant, error) {
	numeric, err := parseID(id)
	if err != nil {
		return authz.Grant{}, err
	}
	row, err := r.data.db.Grant.Get(ctx, numeric)
	if err != nil {
		return authz.Grant{}, err
	}
	return toGrant(row), nil
}

// Create is idempotent: re-granting an identical scope and role returns the existing row rather
// than failing on the unique index, so the UI can be clicked twice without an error.
func (r *grantRepo) Create(ctx context.Context, g authz.Grant) (authz.Grant, error) {
	existing, err := r.data.db.Grant.Query().Where(
		grant.SubjectType(g.SubjectType),
		grant.Subject(g.Subject),
		grant.ResourceType(g.ResourceType),
		grant.Namespace(g.Namespace),
		grant.Name(g.Name),
		grant.Role(g.Role),
	).Only(ctx)
	if err == nil {
		return toGrant(existing), nil
	}
	if !ent.IsNotFound(err) {
		return authz.Grant{}, err
	}

	row, err := r.data.db.Grant.Create().
		SetSubjectType(g.SubjectType).
		SetSubject(g.Subject).
		SetResourceType(g.ResourceType).
		SetNamespace(g.Namespace).
		SetName(g.Name).
		SetRole(g.Role).
		SetCreatedBy(g.CreatedBy).
		Save(ctx)
	if err != nil {
		return authz.Grant{}, err
	}
	return toGrant(row), nil
}

func (r *grantRepo) Delete(ctx context.Context, id string) error {
	numeric, err := parseID(id)
	if err != nil {
		return err
	}
	return r.data.db.Grant.DeleteOneID(numeric).Exec(ctx)
}

func parseID(id string) (int64, error) {
	numeric, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid grant id %q", id)
	}
	return numeric, nil
}

func toGrant(row *ent.Grant) authz.Grant {
	return authz.Grant{
		ID:           strconv.FormatInt(row.ID, 10),
		SubjectType:  row.SubjectType,
		Subject:      row.Subject,
		ResourceType: row.ResourceType,
		Namespace:    row.Namespace,
		Name:         row.Name,
		Role:         row.Role,
		CreatedBy:    row.CreatedBy,
		CreatedAt:    row.CreatedAt,
	}
}

func toGrants(rows []*ent.Grant) []authz.Grant {
	out := make([]authz.Grant, 0, len(rows))
	for _, row := range rows {
		out = append(out, toGrant(row))
	}
	return out
}
