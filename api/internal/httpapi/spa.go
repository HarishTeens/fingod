package httpapi

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"

	"github.com/gorilla/mux"
)

// webdist holds the built React app. The Dockerfile (and `make build`) copies
// web/dist over it before compiling; in a checkout it holds only .gitkeep,
// because `make web` runs Vite on :5173 and proxies /api here.
//
// The directory has to exist for go:embed to compile at all, which is why the
// marker file is tracked while everything beside it is ignored.
//
//go:embed all:webdist
var webdist embed.FS

// placeholder stands in when no UI has been built into the binary. Keeping it
// outside webdist means a real build never leaves a stale tracked file behind.
//
//go:embed placeholder.html
var placeholder []byte

// mountSPA serves the UI at / with client-side routing: any path that is not a
// real file falls back to index.html, so a deep link like /expenses/2026-09
// still boots the app. /api and /healthz are already matched above this.
func mountSPA(r *mux.Router) {
	sub, err := fs.Sub(webdist, "webdist")
	if err != nil {
		panic(err) // impossible: the directory is embedded at compile time
	}
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		r.PathPrefix("/").HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(placeholder)
		})
		return
	}

	files := http.FileServer(http.FS(sub))
	r.PathPrefix("/").HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		path := strings.TrimPrefix(req.URL.Path, "/")
		if path != "" {
			if f, err := sub.Open(path); err == nil {
				f.Close()
				files.ServeHTTP(w, req)
				return
			}
		}
		req = req.Clone(req.Context())
		req.URL.Path = "/"
		files.ServeHTTP(w, req)
	})
}
