package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/harishteens/fingod/api/internal/domain"
)

// maxTransactionBody is generous: Wallet caps a page at 20 records, but a first
// backfill posts years of history in one go.
const maxTransactionBody = 32 << 20

func (s *Server) postTransactions(w http.ResponseWriter, r *http.Request) {
	var batch domain.TransactionBatch
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxTransactionBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&batch); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if err := batch.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	res, err := s.store.UpsertTransactions(r.Context(), batch.Transactions)
	if err != nil {
		s.fail(w, "upsert transactions", err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) refreshState(w http.ResponseWriter, r *http.Request) {
	state, err := s.store.RefreshState(r.Context())
	if err != nil {
		s.fail(w, "read refresh state", err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}
