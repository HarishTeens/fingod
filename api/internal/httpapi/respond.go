package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

type errorBody struct {
	Error  string `json:"error"`
	Detail any    `json:"detail,omitempty"`
	Remedy string `json:"remedy,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("write response", "err", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, errorBody{Error: msg})
}

// writeErrorDetail carries structured context, e.g. the exact accounts that
// blocked a checkpoint, so /refresh can report them without parsing prose.
func writeErrorDetail(w http.ResponseWriter, status int, msg string, detail any, remedy string) {
	writeJSON(w, status, errorBody{Error: msg, Detail: detail, Remedy: remedy})
}
