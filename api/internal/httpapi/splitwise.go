package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gorilla/mux"
	"github.com/harishteens/fingod/api/internal/compute"
	"github.com/harishteens/fingod/api/internal/domain"
	"github.com/harishteens/fingod/api/internal/store"
)

func (s *Server) listSplitwise(w http.ResponseWriter, r *http.Request) {
	balances, err := s.store.SplitwiseBalances(r.Context())
	if err != nil {
		s.fail(w, "list splitwise balances", err)
		return
	}
	net := "0.00"
	for _, b := range balances {
		net = compute.AddMoney(net, b.AmountINR)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"balances": balances,
		"net":      domain.Num(net),
		"count":    len(balances),
	})
}

// setSplitwise adds a person or updates what they owe. One verb for both,
// because from the outside it is one action: "Ravi owes me 3,200 now."
func (s *Server) setSplitwise(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AmountINR domain.Num `json:"amount_inr"`
		Note      string     `json:"note"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}

	b := domain.SplitwiseBalance{
		Person:    mux.Vars(r)["person"],
		AmountINR: body.AmountINR,
		Note:      body.Note,
	}
	if err := b.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	saved, err := s.store.SetSplitwiseBalance(r.Context(), &b)
	if err != nil {
		s.fail(w, "set splitwise balance", err)
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

func (s *Server) deleteSplitwise(w http.ResponseWriter, r *http.Request) {
	err := s.store.DeleteSplitwiseBalance(r.Context(), mux.Vars(r)["person"])
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "nobody by that name on the list")
		return
	}
	if err != nil {
		s.fail(w, "delete splitwise balance", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
