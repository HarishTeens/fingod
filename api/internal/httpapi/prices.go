package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/harishteens/fingod/api/internal/domain"
)

func (s *Server) postPrices(w http.ResponseWriter, r *http.Request) {
	var batch domain.PriceBatch
	// Five years of daily bars for sixty instruments is large even chunked.
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&batch); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if err := batch.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	n, err := s.store.UpsertPrices(r.Context(), batch.Prices)
	if err != nil {
		s.fail(w, "import prices", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"received": len(batch.Prices), "written": n})
}

// getPriceCoverage says what history exists, so a gap is visible before it
// shows up as a line that mysteriously starts late.
func (s *Server) getPriceCoverage(w http.ResponseWriter, r *http.Request) {
	rows, err := s.store.PriceCoverage(r.Context())
	if err != nil {
		s.fail(w, "price coverage", err)
		return
	}
	var missing int
	for _, c := range rows {
		if c.Bars == 0 {
			missing++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"coverage": rows, "instruments": len(rows), "without_prices": missing,
		"note": "One row per instrument the order tape mentions, plus each benchmark. " +
			"An instrument with no bars cannot contribute to a reconstructed series, so its " +
			"sleeve's history silently understates until prices are loaded.",
	})
}
