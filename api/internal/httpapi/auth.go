package httpapi

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// requireToken guards every /api/v1 route with a static bearer token.
//
// This database holds a complete picture of one person's net worth. Twenty
// lines of middleware are what stand between "bound to localhost" and an
// accidental cloud deploy publishing the lot, and the comparison is constant
// time so the token cannot be recovered a byte at a time.
func requireToken(token string) func(http.Handler) http.Handler {
	want := []byte(token)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got, ok := bearer(r)
			if !ok || subtle.ConstantTimeCompare([]byte(got), want) != 1 {
				w.Header().Set("WWW-Authenticate", `Bearer realm="fingod"`)
				writeError(w, http.StatusUnauthorized, "missing or invalid bearer token")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func bearer(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) <= len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return "", false
	}
	return strings.TrimSpace(h[len(prefix):]), true
}
