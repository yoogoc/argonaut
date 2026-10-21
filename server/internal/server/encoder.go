package server

import (
	"encoding/json"
	stdhttp "net/http"

	"github.com/go-kratos/kratos/v3/transport/http"
)

// Responses are encoded with encoding/json rather than Kratos' default protojson.
//
// protojson refuses to marshal types it does not recognise as protobuf scalars, and Argo's API is
// full of them — WorkflowStatus.estimatedDuration is a v1alpha1.EstimatedDuration, and there are
// several more. Since nearly every reply embeds an Argo object, a per-endpoint workaround would be a
// standing trap for the next endpoint added; encoding the whole API with encoding/json avoids the
// class of bug outright.
//
// The wire shape stays what the UI expects: protoc generates JSON tags from the proto field names,
// which are already lowerCamelCase, and Argo's own types carry the same JSON tags the Argo API uses.
// The one visible difference from protojson is that 64-bit integers are numbers rather than strings,
// which is what JavaScript wants anyway.
func responseEncoder(w http.ResponseWriter, r *http.Request, v any) error {
	if v == nil {
		return nil
	}
	if rd, ok := v.(http.Redirector); ok {
		url, code := rd.Redirect()
		stdhttp.Redirect(w, r, url, code)
		return nil
	}

	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json")
	_, err = w.Write(data)
	return err
}
