package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/harishteens/fingod/api/internal/domain"
)

func (s *Server) putUSCostBasis(w http.ResponseWriter, r *http.Request) {
	var batch domain.USCostBasisBatch
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&batch); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if err := batch.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	n, err := s.store.ReplaceUSCostBasis(r.Context(), batch)
	if err != nil {
		s.fail(w, "replace us cost basis", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"positions": n, "fx_rates": len(batch.FXRates), "source": batch.Source,
	})
}

func (s *Server) getUSCostBasis(w http.ResponseWriter, r *http.Request) {
	basis, err := s.store.USCostBasis(r.Context())
	if err != nil {
		s.fail(w, "list us cost basis", err)
		return
	}
	rates, err := s.store.FXRates(r.Context())
	if err != nil {
		s.fail(w, "list fx rates", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"positions": basis,
		"fx_rates":  rates,
		"note": "cost_inr is FIFO'd from the broker order book at the USD/INR that applied on each " +
			"buy date. INDmoney's own invested_amount is deliberately ignored: it back-converts the " +
			"USD cost at a flat 92.0000 whatever the purchase date, which misstated cost and " +
			"inflated the reported US gain by half again. buy_rate is the blended " +
			"rate actually paid — above the live rate means the rupee has since firmed and is " +
			"working against the position, below means it is working for it.",
	})
}
