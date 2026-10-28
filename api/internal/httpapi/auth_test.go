package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequireToken(t *testing.T) {
	const token = "0123456789abcdef0123456789abcdef"
	var reached bool
	h := requireToken(token)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusNoContent)
	}))

	cases := []struct {
		name   string
		header string
		want   int
	}{
		{"no header", "", http.StatusUnauthorized},
		{"wrong token", "Bearer wrong", http.StatusUnauthorized},
		{"right token, wrong scheme", "Basic " + token, http.StatusUnauthorized},
		{"prefix of the token", "Bearer " + token[:8], http.StatusUnauthorized},
		{"token with trailing junk", "Bearer " + token + "x", http.StatusUnauthorized},
		{"correct", "Bearer " + token, http.StatusNoContent},
		{"correct, lowercase scheme", "bearer " + token, http.StatusNoContent},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reached = false
			req := httptest.NewRequest(http.MethodGet, "/api/v1/checkpoints", nil)
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if rec.Code != tc.want {
				t.Errorf("status %d, want %d", rec.Code, tc.want)
			}
			if want := tc.want == http.StatusNoContent; reached != want {
				t.Errorf("handler reached = %v, want %v", reached, want)
			}
			if tc.want == http.StatusUnauthorized && rec.Header().Get("WWW-Authenticate") == "" {
				t.Error("401 without a WWW-Authenticate header")
			}
		})
	}
}
