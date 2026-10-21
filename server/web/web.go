// Package web serves the compiled UI from the server binary, so a deployment is one image and the UI
// can never be a different version than the API it talks to.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// dist is filled by `pnpm build` in ui/ (vite writes straight into server/web/dist). Only .gitkeep is
// committed, so a server built without the UI still compiles and says what is missing.
//
//go:embed all:dist
var dist embed.FS

// Handler serves static assets and falls back to index.html for client-side routes.
func Handler() http.Handler {
	root, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	files := http.FileServer(http.FS(root))
	index, indexErr := fs.ReadFile(root, "index.html")

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name != "" && name != "index.html" {
			if info, err := fs.Stat(root, name); err == nil && !info.IsDir() {
				// Vite fingerprints everything under assets/, so those can be cached forever; the
				// index must always be revalidated or a deploy would keep serving stale chunk names.
				if strings.HasPrefix(name, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		if indexErr != nil {
			http.Error(w, "the UI is not built into this binary: run `pnpm build` in ui/ and rebuild the server", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(index)
	})
}
