package service

import (
	"context"
	"log/slog"

	v1 "argonaut/api/v1"
	"argonaut/internal/authz"
	"argonaut/internal/biz"

	"google.golang.org/protobuf/types/known/emptypb"
)

// AuthzService exposes grant administration. Authorization for these calls is itself enforced by
// the policy: handing out a permission requires the authz:grant action on the target scope.
type AuthzService struct {
	v1.UnimplementedAuthzServiceServer

	log *slog.Logger
	uc  *biz.AuthzUsecase
}

func NewAuthzService(uc *biz.AuthzUsecase, logger *slog.Logger) *AuthzService {
	return &AuthzService{log: logger.With("module", "service/authz"), uc: uc}
}

func (s *AuthzService) ListGrants(ctx context.Context, req *v1.ListGrantsRequest) (*v1.ListGrantsReply, error) {
	grants, err := s.uc.ListGrants(ctx, req.GetSubject(), req.GetNamespace(), req.GetName())
	if err != nil {
		return nil, err
	}
	return &v1.ListGrantsReply{Grants: toProtoGrants(grants)}, nil
}

func (s *AuthzService) CreateGrant(ctx context.Context, req *v1.CreateGrantRequest) (*v1.GrantReply, error) {
	created, err := s.uc.CreateGrant(ctx, authz.Grant{
		SubjectType:  req.GetSubjectType(),
		Subject:      req.GetSubject(),
		ResourceType: req.GetResourceType(),
		Namespace:    req.GetNamespace(),
		Name:         req.GetName(),
		Role:         req.GetRole(),
	})
	if err != nil {
		return nil, err
	}
	return &v1.GrantReply{Grant: toProtoGrant(created)}, nil
}

func (s *AuthzService) DeleteGrant(ctx context.Context, req *v1.DeleteGrantRequest) (*v1.DeleteGrantReply, error) {
	if err := s.uc.DeleteGrant(ctx, req.GetId()); err != nil {
		return nil, err
	}
	return &v1.DeleteGrantReply{}, nil
}

func (s *AuthzService) ListRoles(_ context.Context, _ *emptypb.Empty) (*v1.ListRolesReply, error) {
	roles := s.uc.Roles()
	out := make([]*v1.Role, 0, len(roles))
	for _, r := range roles {
		actions := make([]string, 0, len(r.Actions))
		for _, a := range r.Actions {
			actions = append(actions, string(a))
		}
		out = append(out, &v1.Role{Name: r.Name, Actions: actions, Description: r.Description})
	}
	return &v1.ListRolesReply{Roles: out}, nil
}

func (s *AuthzService) MyPermissions(ctx context.Context, _ *emptypb.Empty) (*v1.MyPermissionsReply, error) {
	subject, superAdmin, grants, err := s.uc.MyPermissions(ctx)
	if err != nil {
		return nil, err
	}
	return &v1.MyPermissionsReply{
		Subject:    subject,
		SuperAdmin: superAdmin,
		Grants:     toProtoGrants(grants),
	}, nil
}

func toProtoGrant(g authz.Grant) *v1.Grant {
	return &v1.Grant{
		Id:           g.ID,
		SubjectType:  g.SubjectType,
		Subject:      g.Subject,
		ResourceType: g.ResourceType,
		Namespace:    g.Namespace,
		Name:         g.Name,
		Role:         g.Role,
		CreatedBy:    g.CreatedBy,
		CreatedAt:    g.CreatedAt.UTC().Format(timeFormat),
	}
}

func toProtoGrants(grants []authz.Grant) []*v1.Grant {
	out := make([]*v1.Grant, 0, len(grants))
	for _, g := range grants {
		out = append(out, toProtoGrant(g))
	}
	return out
}
