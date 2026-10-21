package service

import (
	"context"
	"log/slog"

	v1 "argonaut/api/v1"
	"argonaut/internal/conf"
	pkgargo "argonaut/pkg/argo"

	"google.golang.org/protobuf/types/known/emptypb"
)

// Version is set at build time with -ldflags "-X argonaut/internal/service.Version=x.y.z".
var Version = "dev"

// InfoService reports what the server discovered about the cluster it is attached to. Argo's own
// InfoService is unavailable without argo-server, so this is implemented locally.
type InfoService struct {
	v1.UnimplementedInfoServiceServer

	log     *slog.Logger
	servers *pkgargo.Servers
	kube    *conf.Kube
}

func NewInfoService(servers *pkgargo.Servers, kubeConf *conf.Kube, logger *slog.Logger) *InfoService {
	return &InfoService{log: logger.With("module", "service/info"), servers: servers, kube: kubeConf}
}

func (s *InfoService) GetInfo(_ context.Context, _ *emptypb.Empty) (*v1.GetInfoReply, error) {
	links := make([]*v1.Link, 0, len(s.servers.Config.Links))
	for _, l := range s.servers.Config.Links {
		links = append(links, &v1.Link{Name: l.Name, Scope: l.Scope, Url: l.URL})
	}

	namespaces := s.kube.GetNamespaces()
	if managed := s.servers.Namespace; managed != "" {
		// A managed namespace is the only one that can be reached, so offering others would only
		// produce empty pages.
		namespaces = []string{managed}
	}

	return &v1.GetInfoReply{
		Version:                  Version,
		ManagedNamespace:         s.servers.Namespace,
		Namespaces:               namespaces,
		NodeStatusOffloadEnabled: s.servers.OffloadEnabled,
		Links:                    links,
		ArchiveEnabled:           s.servers.ArchiveEnabled,
	}, nil
}
