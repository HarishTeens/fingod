package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/gorilla/mux"
	"github.com/harishteens/fingod/api/internal/domain"
	"github.com/harishteens/fingod/api/internal/store"
)

func (s *Server) listWalletAccounts(w http.ResponseWriter, r *http.Request) {
	accounts, err := s.store.WalletAccounts(r.Context())
	if err != nil {
		s.fail(w, "list wallet accounts", err)
		return
	}
	unclassified := 0
	for _, a := range accounts {
		if a.Role == nil {
			unclassified++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"accounts":     accounts,
		"unclassified": unclassified,
	})
}

func (s *Server) classifyWalletAccount(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Role          *string `json:"role"`
		RoleNote      *string `json:"role_note"`
		BalanceSource *string `json:"balance_source"`
		ExternalRef   *string `json:"external_ref"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if body.Role != nil && !slices.Contains(domain.WalletRoles, *body.Role) {
		writeError(w, http.StatusBadRequest,
			"role must be one of "+strings.Join(domain.WalletRoles, ", "))
		return
	}
	if body.BalanceSource != nil {
		if !slices.Contains(domain.BalanceSources, *body.BalanceSource) {
			writeError(w, http.StatusBadRequest,
				"balance_source must be one of "+strings.Join(domain.BalanceSources, ", "))
			return
		}
		if *body.BalanceSource == domain.BalanceFromINDmoney && body.ExternalRef == nil {
			writeError(w, http.StatusBadRequest,
				"external_ref is required with balance_source=indmoney — name the INDmoney SA row, e.g. \"Primary bank\"")
			return
		}
	}
	if body.Role == nil && body.RoleNote == nil && body.BalanceSource == nil && body.ExternalRef == nil {
		writeError(w, http.StatusBadRequest, "nothing to change")
		return
	}

	account, err := s.store.ClassifyWalletAccount(r.Context(), mux.Vars(r)["id"],
		body.Role, body.RoleNote, body.BalanceSource, body.ExternalRef)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "no such Wallet account — it is recorded on the first checkpoint that sees it")
		return
	}
	if err != nil {
		s.fail(w, "classify wallet account", err)
		return
	}
	writeJSON(w, http.StatusOK, account)
}
