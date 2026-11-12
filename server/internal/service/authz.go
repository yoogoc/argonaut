package service

import (
	"context"
	"log/slog"

	v1 "argonaut/api/v1"
	"argonaut/internal/authz"
	"argonaut/internal/biz"

	"google.golang.org/protobuf/types/known/emptypb"
)

// AuthzService exposes grant administration and permission queries. Administration is itself
// governed by the policy: handing out a permission requires authz:grant on the target scope.
type AuthzService struct {
	v1.UnimplementedAuthzServiceServer

	log      *slog.Logger
	uc       *biz.AuthzUsecase
	audit    *biz.Auditor
	accounts *biz.Accounts
}

func NewAuthzService(uc *biz.AuthzUsecase, auditor *biz.Auditor, accounts *biz.Accounts, logger *slog.Logger) *AuthzService {
	return &AuthzService{log: logger.With("module", "service/authz"), uc: uc, audit: auditor, accounts: accounts}
}

func (s *AuthzService) ListGrants(ctx context.Context, req *v1.ListGrantsRequest) (*v1.ListGrantsReply, error) {
	grants, err := s.uc.ListGrants(ctx, req.GetSubject(), req.GetNamespace(), req.GetName())
	if err != nil {
		return nil, err
	}
	return &v1.ListGrantsReply{Grants: toProtoGrants(grants)}, nil
}

func (s *AuthzService) SearchUsers(ctx context.Context, req *v1.SearchUsersRequest) (*v1.SearchUsersReply, error) {
	resource := authz.Resource{Namespace: req.GetNamespace(), Template: req.GetTemplate(), ClusterTemplate: req.GetClusterTemplate()}
	users, err := s.uc.SearchUsers(ctx, req.GetQuery(), resource)
	if err != nil {
		return nil, err
	}
	out := make([]*v1.DirectoryUser, 0, len(users))
	for _, user := range users {
		out = append(out, toProtoUser(user))
	}
	return &v1.SearchUsersReply{Users: out}, nil
}

func (s *AuthzService) ListUsers(ctx context.Context, req *v1.ListUsersRequest) (*v1.ListUsersReply, error) {
	users, more, err := s.uc.ListUsers(ctx, req.GetQuery(), int(req.GetLimit()), int(req.GetOffset()))
	if err != nil {
		return nil, err
	}
	out := make([]*v1.DirectoryUser, 0, len(users))
	for _, user := range users {
		entry := toProtoUser(user)
		if user.LastLoginAt != nil {
			entry.LastLoginAt = user.LastLoginAt.UTC().Format(timeFormat)
		}
		out = append(out, entry)
	}
	return &v1.ListUsersReply{Users: out, HasMore: more, AccountCreationAvailable: s.accounts.Available()}, nil
}

func (s *AuthzService) CreateUser(ctx context.Context, req *v1.CreateUserRequest) (*v1.DirectoryUser, error) {
	user, err := s.accounts.CreateUser(ctx, fromCreateUser(req))
	if err != nil {
		return nil, err
	}
	return toProtoUser(user), nil
}

func (s *AuthzService) SetupStatus(ctx context.Context, _ *emptypb.Empty) (*v1.SetupStatusReply, error) {
	required, available, err := s.accounts.SetupStatus(ctx)
	if err != nil {
		return nil, err
	}
	return &v1.SetupStatusReply{Required: required, Available: available}, nil
}

func (s *AuthzService) SetupAdmin(ctx context.Context, req *v1.SetupAdminRequest) (*v1.DirectoryUser, error) {
	user, err := s.accounts.SetupAdmin(ctx, req.GetToken(), fromCreateUser(req.GetUser()))
	if err != nil {
		return nil, err
	}
	return toProtoUser(user), nil
}

func fromCreateUser(req *v1.CreateUserRequest) biz.NewAccount {
	return biz.NewAccount{Name: req.GetName(), Email: req.GetEmail()}
}

func toProtoUser(user biz.User) *v1.DirectoryUser {
	return &v1.DirectoryUser{Subject: user.Subject, Name: user.Name, Email: user.Email, EmailVerified: user.EmailVerified}
}

func (s *AuthzService) CreateGrant(ctx context.Context, req *v1.CreateGrantRequest) (*v1.GrantReply, error) {
	created, rev, err := s.uc.CreateGrant(ctx, authz.Grant{
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
	setRevisionHeader(ctx, rev)
	return &v1.GrantReply{Grant: toProtoGrant(created), Revision: rev}, nil
}

func (s *AuthzService) DeleteGrant(ctx context.Context, req *v1.DeleteGrantRequest) (*v1.DeleteGrantReply, error) {
	rev, err := s.uc.DeleteGrant(ctx, req.GetId())
	if err != nil {
		return nil, err
	}
	setRevisionHeader(ctx, rev)
	return &v1.DeleteGrantReply{Revision: rev}, nil
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
	subject, superAdmin, rev, grants, err := s.uc.MyPermissions(ctx)
	if err != nil {
		return nil, err
	}
	return &v1.MyPermissionsReply{Subject: subject, SuperAdmin: superAdmin, Grants: toProtoGrants(grants), Revision: rev}, nil
}

func (s *AuthzService) Actions(ctx context.Context, req *v1.ActionsRequest) (*v1.ActionsReply, error) {
	res := authz.Resource{Namespace: req.GetNamespace(), Template: req.GetTemplate(), ClusterTemplate: req.GetClusterTemplate()}
	if res.ClusterTemplate != "" {
		res.Namespace, res.Template = "", ""
	}
	actions, err := s.uc.Actions(ctx, res)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(actions))
	for _, a := range actions {
		out = append(out, string(a))
	}
	return &v1.ActionsReply{Actions: out, Revision: s.uc.Revision()}, nil
}

func (s *AuthzService) Status(ctx context.Context, _ *emptypb.Empty) (*v1.AuthzStatusReply, error) {
	st, err := s.uc.Status(ctx)
	if err != nil {
		return nil, err
	}
	reply := &v1.AuthzStatusReply{Revision: st.Revision}
	for _, r := range st.Replicas {
		reply.Replicas = append(reply.Replicas, &v1.Replica{Id: r.ID, Revision: r.Revision, SeenAt: r.SeenAt.UTC().Format(timeFormat)})
	}
	if st.LastChange != nil {
		reply.LastChange = toProtoAudit(*st.LastChange)
	}
	return reply, nil
}

func (s *AuthzService) OrphanGrants(ctx context.Context, _ *emptypb.Empty) (*v1.ListGrantsReply, error) {
	grants, err := s.uc.OrphanGrants(ctx)
	if err != nil {
		return nil, err
	}
	return &v1.ListGrantsReply{Grants: toProtoGrants(grants)}, nil
}

// ListAudit is open to administrators of any scope; everyone else sees only their own actions.
func (s *AuthzService) ListAudit(ctx context.Context, req *v1.ListAuditRequest) (*v1.ListAuditReply, error) {
	if err := s.uc.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	filter := biz.AuditFilter{Actor: req.GetActor(), Action: req.GetAction(), Result: req.GetResult(), Limit: int(req.GetLimit()), Offset: int(req.GetOffset())}
	if !s.uc.Allow(ctx, authz.AuthzGrant, authz.Global()) {
		subject, _, _, grants, _ := s.uc.MyPermissions(ctx)
		admin := false
		for _, g := range grants {
			if g.Role == authz.RoleAdmin {
				admin = true
			}
		}
		if !admin {
			filter.Actor = subject
		}
	}
	events, total, err := s.audit.List(ctx, filter)
	if err != nil {
		return nil, err
	}
	reply := &v1.ListAuditReply{Total: int32(total)}
	for _, ev := range events {
		reply.Events = append(reply.Events, toProtoAudit(ev))
	}
	return reply, nil
}

func (s *AuthzService) ListPolicies(ctx context.Context, _ *emptypb.Empty) (*v1.ListPoliciesReply, error) {
	policies, err := s.uc.ListPolicies(ctx)
	if err != nil {
		return nil, err
	}
	reply := &v1.ListPoliciesReply{
		Builtins: &v1.BuiltinPolicies{
			Source:                   policies.BuiltinSource,
			ClusterTemplatesReadable: policies.ClusterTemplatesReadable,
		},
	}
	for _, p := range policies.Custom {
		reply.Policies = append(reply.Policies, toProtoPolicy(p, policies.Broken[p.Name]))
	}
	return reply, nil
}

func (s *AuthzService) CreatePolicy(ctx context.Context, req *v1.CreatePolicyRequest) (*v1.PolicyReply, error) {
	p, rev, err := s.uc.CreatePolicy(ctx, authz.CustomPolicy{Name: req.GetName(), Description: req.GetDescription(), Body: req.GetBody()})
	if err != nil {
		return nil, err
	}
	setRevisionHeader(ctx, rev)
	return &v1.PolicyReply{Policy: toProtoPolicy(p, ""), Revision: rev}, nil
}

func (s *AuthzService) SetPolicyEnabled(ctx context.Context, req *v1.SetPolicyEnabledRequest) (*v1.RevisionReply, error) {
	rev, err := s.uc.SetPolicyEnabled(ctx, req.GetId(), req.GetName(), req.GetEnabled())
	if err != nil {
		return nil, err
	}
	setRevisionHeader(ctx, rev)
	return &v1.RevisionReply{Revision: rev}, nil
}

func (s *AuthzService) DeletePolicy(ctx context.Context, req *v1.DeletePolicyRequest) (*v1.RevisionReply, error) {
	rev, err := s.uc.DeletePolicy(ctx, req.GetId(), req.GetName())
	if err != nil {
		return nil, err
	}
	setRevisionHeader(ctx, rev)
	return &v1.RevisionReply{Revision: rev}, nil
}

func toProtoPolicy(p authz.CustomPolicy, compileErr string) *v1.Policy {
	return &v1.Policy{
		Id: p.ID, Name: p.Name, Description: p.Description, Body: p.Body, Enabled: p.Enabled,
		CreatedBy: p.CreatedBy, CreatedAt: p.CreatedAt.UTC().Format(timeFormat), Revision: p.Revision, Error: compileErr,
	}
}

func toProtoAudit(ev biz.AuditEvent) *v1.AuditEvent {
	return &v1.AuditEvent{
		Id: ev.ID, At: ev.At.UTC().Format(timeFormat), Actor: ev.Actor, Action: ev.Action, ResourceType: ev.ResourceType,
		Namespace: ev.Namespace, Name: ev.Name, Result: ev.Result, Reason: ev.Reason, Detail: string(ev.Detail), Revision: ev.Revision,
		Cluster: ev.Cluster,
	}
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
		Revision:     g.Revision,
	}
}

func toProtoGrants(grants []authz.Grant) []*v1.Grant {
	out := make([]*v1.Grant, 0, len(grants))
	for _, g := range grants {
		out = append(out, toProtoGrant(g))
	}
	return out
}
