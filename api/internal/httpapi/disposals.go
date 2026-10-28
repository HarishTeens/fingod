package httpapi

import (
	"net/http"

	"github.com/harishteens/fingod/api/internal/compute"
)

// getDisposals reports what was sold between two checkpoints.
//
// Defaults to the two most recent, which is what /refresh wants: "since I last
// looked, what left". Everything about the sale is derivable except the price
// it went out at, so the response carries an estimate at the last known price
// and says so — the refresh confirms it rather than banking a guess.
func (s *Server) getDisposals(w http.ResponseWriter, r *http.Request) {
	from, err := dateParam(r, "from")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	to, err := dateParam(r, "to")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	checkpoints, err := s.store.CheckpointsWithDetail(r.Context(), from, to)
	if err != nil {
		s.fail(w, "read checkpoints", err)
		return
	}
	if len(checkpoints) < 2 {
		writeJSON(w, http.StatusOK, map[string]any{
			"disposals": []any{},
			"count":     0,
			"note": "A sale is visible only as the difference between two checkpoints, and there " +
				"are fewer than two in this range. Nothing sold can be detected yet.",
		})
		return
	}

	prev := checkpoints[len(checkpoints)-2]
	last := checkpoints[len(checkpoints)-1]
	disposals, err := compute.FindDisposals(prev.Holdings, last.Holdings,
		prev.AsOfDate.String(), last.AsOfDate.String())
	if err != nil {
		s.fail(w, "find disposals", err)
		return
	}

	// Anything already recorded as a trade is filtered out, so a re-run of
	// /refresh does not offer the same sale twice.
	recorded, err := s.store.Trades(r.Context(), "", &prev.AsOfDate, nil)
	if err != nil {
		s.fail(w, "read trades", err)
		return
	}
	seen := map[string]bool{}
	for _, t := range recorded {
		seen[t.Sleeve+"\x00"+t.Symbol] = true
	}
	pending := make([]compute.Disposal, 0, len(disposals))
	for _, d := range disposals {
		if !seen[d.Sleeve+"\x00"+d.Symbol] {
			pending = append(pending, d)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"between":        [2]string{prev.AsOfDate.String(), last.AsOfDate.String()},
		"disposals":      pending,
		"count":          len(pending),
		"already_logged": len(disposals) - len(pending),
		"note": "estimated_proceeds values the sale at the PREVIOUS checkpoint's price, which is " +
			"the last one fingod saw. It is a starting point, not the sale price — confirm the " +
			"real one before recording the trade.",
	})
}
