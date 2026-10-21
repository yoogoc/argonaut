package service

import (
	"io"
	"log/slog"
	"net/http"
	"path"
	"strings"

	"argonaut/internal/biz"

	"github.com/go-kratos/kratos/v3/errors"
)

// ArtifactHandler serves artifact downloads as raw HTTP rather than as an RPC, because artifacts can
// be gigabytes: the reply is streamed straight from the object store to the client instead of being
// buffered into a protobuf message. Authorization is the same check the RPCs use.
type ArtifactHandler struct {
	log *slog.Logger
	uc  *biz.WorkflowUsecase
}

func NewArtifactHandler(uc *biz.WorkflowUsecase, logger *slog.Logger) *ArtifactHandler {
	return &ArtifactHandler{log: logger.With("module", "service/artifact"), uc: uc}
}

// Output serves a node's output artifact.
func (h *ArtifactHandler) Output(w http.ResponseWriter, r *http.Request) {
	h.serve(w, r, "/api/v1/artifacts/", false)
}

// Input serves a node's input artifact.
func (h *ArtifactHandler) Input(w http.ResponseWriter, r *http.Request) {
	h.serve(w, r, "/api/v1/input-artifacts/", true)
}

func (h *ArtifactHandler) serve(w http.ResponseWriter, r *http.Request, prefix string, isInput bool) {
	namespace, name, nodeID, artifactName, ok := parseArtifactPath(r.URL.Path, prefix)
	if !ok {
		http.Error(w, "expected {namespace}/{name}/{nodeId}/{artifactName}", http.StatusBadRequest)
		return
	}

	art, reader, err := h.uc.OpenArtifact(r.Context(), namespace, name, nodeID, artifactName, isInput)
	if err != nil {
		h.writeError(w, err)
		return
	}
	defer func() {
		if cerr := reader.Close(); cerr != nil {
			h.log.Warn("closing artifact reader", "err", cerr)
		}
	}()

	// Content-Disposition makes the browser download rather than try to render the bytes, and the
	// artifact's own key gives it a meaningful filename.
	filename := path.Base(artifactName)
	if art != nil {
		if key, kerr := art.GetKey(); kerr == nil && key != "" {
			filename = path.Base(key)
		}
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+filename+"\"")

	if _, err := io.Copy(w, reader); err != nil {
		// The status line is already sent, so this can only be logged.
		h.log.Warn("artifact stream interrupted", "namespace", namespace, "workflow", name,
			"node", nodeID, "artifact", artifactName, "err", err)
	}
}

// parseArtifactPath splits "{prefix}{namespace}/{name}/{nodeId}/{artifactName}". The artifact name is
// allowed to contain slashes, since Argo artifact names can be paths.
func parseArtifactPath(urlPath, prefix string) (namespace, name, nodeID, artifactName string, ok bool) {
	rest, found := strings.CutPrefix(urlPath, prefix)
	if !found {
		return "", "", "", "", false
	}
	parts := strings.SplitN(strings.Trim(rest, "/"), "/", 4)
	if len(parts) != 4 {
		return "", "", "", "", false
	}
	for _, p := range parts {
		if p == "" {
			return "", "", "", "", false
		}
	}
	return parts[0], parts[1], parts[2], parts[3], true
}

func (h *ArtifactHandler) writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	if code := int(errors.Code(err)); code >= 400 && code < 600 {
		status = code
	}
	http.Error(w, err.Error(), status)
}
