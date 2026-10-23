package service

import (
	"context"
	stderrors "errors"
	"log/slog"

	v1 "argonaut/api/v1"
	"argonaut/internal/authz"
	"argonaut/internal/biz"
	pkgargo "argonaut/pkg/argo"

	"github.com/go-kratos/kratos/v3/errors"
	"google.golang.org/protobuf/types/known/emptypb"
)

// ClusterHeader carries the id of the cluster that answered, so a page notices when someone else
// switched the instance (docs/multi-cluster.md).
const ClusterHeader = "X-Argonaut-Cluster"

// ClusterService lists and switches the clusters an instance can be connected to.
type ClusterService struct {
	v1.UnimplementedClusterServiceServer

	log   *slog.Logger
	sw    *pkgargo.ClusterSwitch
	authz *biz.AuthzUsecase
}

func NewClusterService(sw *pkgargo.ClusterSwitch, authzUC *biz.AuthzUsecase, logger *slog.Logger) *ClusterService {
	return &ClusterService{log: logger.With("module", "service/cluster"), sw: sw, authz: authzUC}
}

func (s *ClusterService) List(ctx context.Context, _ *emptypb.Empty) (*v1.ListClustersReply, error) {
	if err := s.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	reply := &v1.ListClustersReply{Enabled: s.sw.Enabled()}
	for _, c := range s.sw.Statuses() {
		reply.Clusters = append(reply.Clusters, &v1.ClusterStatus{
			Id: c.ID, Name: c.Name, Env: c.Env, Current: c.Current, Switching: c.Switching, LastError: c.LastError,
			Context: c.Kube.GetContext(), Namespaces: c.Kube.GetNamespaces(),
		})
	}
	return reply, nil
}

func (s *ClusterService) Switch(ctx context.Context, req *v1.SwitchClusterRequest) (*v1.SwitchClusterReply, error) {
	if !s.sw.Enabled() {
		return nil, errors.NotFound("not_found", pkgargo.ErrSwitchDisabled.Error())
	}
	if err := s.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	// Switching moves every user of the instance to another cluster, so only a super admin may.
	if !s.authz.IsSuperAdmin(ctx) {
		return nil, errors.Forbidden("forbidden", "only a super admin can switch the instance to another cluster")
	}
	from := s.sw.For(ctx).ID
	rt, err := s.sw.Switch(ctx, req.GetId())
	if err != nil {
		if stderrors.Is(err, pkgargo.ErrSwitchDisabled) {
			return nil, errors.NotFound("not_found", err.Error())
		}
		s.authz.Audit().Record(ctx, authz.Action("cluster:switch"), authz.Global(), biz.AuditDenied, err.Error(), map[string]any{"from": from, "to": req.GetId()}, s.authz.Revision())
		return nil, errors.New(502, "cluster_unavailable", err.Error())
	}
	s.authz.Audit().Record(ctx, authz.Action("cluster:switch"), authz.Global(), biz.AuditAllowed, "", map[string]any{"from": from, "to": rt.ID}, s.authz.Revision())
	return &v1.SwitchClusterReply{Cluster: &v1.ClusterInfo{Id: rt.ID, Name: rt.Name, Env: rt.Env}}, nil
}
