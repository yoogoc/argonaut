package service

import (
	"context"
	"log/slog"

	v1 "argonaut/api/v1"
	pkgargo "argonaut/pkg/argo"

	"google.golang.org/protobuf/types/known/emptypb"
)

// Version is set at build time with -ldflags "-X argonaut/internal/service.Version=x.y.z".
var Version = "dev"

// InfoService reports what the server discovered about the cluster it is attached to. Argo's own
// InfoService is unavailable without argo-server, so this is implemented locally.
type InfoService struct {
	v1.UnimplementedInfoServiceServer

	log *slog.Logger
	sw  *pkgargo.ClusterSwitch
}

func NewInfoService(sw *pkgargo.ClusterSwitch, logger *slog.Logger) *InfoService {
	return &InfoService{log: logger.With("module", "service/info"), sw: sw}
}

func (s *InfoService) GetInfo(ctx context.Context, _ *emptypb.Empty) (*v1.GetInfoReply, error) {
	rt := s.sw.For(ctx)
	servers := rt.Servers
	links := make([]*v1.Link, 0, len(servers.Config.Links))
	for _, l := range servers.Config.Links {
		links = append(links, &v1.Link{Name: l.Name, Scope: l.Scope, Url: l.URL})
	}

	namespaces := rt.Kube.GetNamespaces()
	if managed := servers.Namespace; managed != "" {
		// A managed namespace is the only one that can be reached, so offering others would only
		// produce empty pages.
		namespaces = []string{managed}
	}

	return &v1.GetInfoReply{
		Version:                  Version,
		ManagedNamespace:         servers.Namespace,
		Namespaces:               namespaces,
		NodeStatusOffloadEnabled: servers.OffloadEnabled,
		Links:                    links,
		ArchiveEnabled:           servers.ArchiveEnabled,
		Cluster:                  clusterInfo(rt, s.sw.Enabled()),
	}, nil
}

// clusterInfo describes the connected cluster, when the instance can be switched between several.
func clusterInfo(rt *pkgargo.Runtime, switchable bool) *v1.ClusterInfo {
	if !switchable {
		return nil
	}
	return &v1.ClusterInfo{Id: rt.ID, Name: rt.Name, Env: rt.Env}
}
