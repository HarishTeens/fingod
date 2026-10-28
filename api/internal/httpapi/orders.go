package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/harishteens/fingod/api/internal/domain"
)

func (s *Server) postOrders(w http.ResponseWriter, r *http.Request) {
	var batch domain.OrderBatch
	// The whole Zerodha tape is ~364 rows and the US book 20, but a first
	// backfill of everything at once should not need paging.
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&batch); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if err := batch.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	inserted, updated, err := s.store.UpsertOrders(r.Context(), batch.Orders)
	if err != nil {
		s.fail(w, "import orders", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"received": len(batch.Orders), "inserted": inserted, "updated": updated,
	})
}

func (s *Server) getOrders(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	orders, err := s.store.Orders(r.Context(), q.Get("sleeve"), q.Get("symbol"), limit)
	if err != nil {
		s.fail(w, "list orders", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"orders": orders, "count": len(orders)})
}

// getReconcile is why the tape is stored at all.
func (s *Server) getReconcile(w http.ResponseWriter, r *http.Request) {
	rows, err := s.store.ReconcileOrders(r.Context())
	if err != nil {
		s.fail(w, "reconcile orders", err)
		return
	}
	var ok, problems int
	for _, p := range rows {
		if p.Status == "ok" {
			ok++
		} else {
			problems++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"positions": rows,
		"reconciled": ok,
		"problems":   problems,
		"note": "Quantity implied by the order tape against the latest checkpoint's holdings. " +
			"A match corroborates the position from two independent directions. A mismatch is " +
			"a real event — a split, a dividend paid in units, or a gap in the export — and each " +
			"one silently corrupts a cost basis derived from buys alone. Kite's own average_price " +
			"already accounts for splits and for purchases predating the tape, which is why it " +
			"stays authoritative for the Indian sleeves rather than being recomputed from here.",
	})
}
