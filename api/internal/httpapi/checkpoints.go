package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/gorilla/mux"
	"github.com/harishteens/fingod/api/internal/domain"
	"github.com/harishteens/fingod/api/internal/store"
)

// maxBody caps a checkpoint payload. A full snapshot is a few hundred rows;
// anything past a megabyte is a mistake, and reading it unbounded is how a
// typo becomes an out-of-memory.
const maxBody = 4 << 20

func (s *Server) postCheckpoint(w http.ResponseWriter, r *http.Request) {
	var in domain.CheckpointInput
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody))
	dec.DisallowUnknownFields() // a typo'd field is a silently dropped holding
	if err := dec.Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if err := in.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	res, err := s.store.SaveCheckpoint(r.Context(), &in)
	var unclassified store.UnclassifiedAccountsError
	switch {
	case errors.As(err, &unclassified):
		writeErrorDetail(w, http.StatusConflict, unclassified.Error(), unclassified.Accounts,
			"Classify each account as cash, credit_card or ignore via "+
				"PATCH /api/v1/wallet-accounts/{id}, then re-post this checkpoint. "+
				"Nothing is guessed: Wallet types its fixed deposit the same as a salary account.")
		return
	case err != nil:
		s.fail(w, "save checkpoint", err)
		return
	}

	status := http.StatusCreated
	if res.Replaced {
		status = http.StatusOK
	}
	writeJSON(w, status, res)
}

func (s *Server) listCheckpoints(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = n
	}
	list, err := s.store.ListCheckpoints(r.Context(), limit)
	if err != nil {
		s.fail(w, "list checkpoints", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"checkpoints": list, "count": len(list)})
}

func (s *Server) getCheckpoint(w http.ResponseWriter, r *http.Request) {
	at, err := domain.ParseDate(mux.Vars(r)["date"])
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	cp, err := s.store.GetCheckpoint(r.Context(), at)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "no checkpoint on "+at.String())
		return
	}
	if err != nil {
		s.fail(w, "get checkpoint", err)
		return
	}
	writeJSON(w, http.StatusOK, cp)
}
