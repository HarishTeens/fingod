package httpapi

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"slices"
	"sort"
	"strings"

	"github.com/harishteens/fingod/api/internal/domain"
)

// allocationKeys are what a target may name: the sleeves, plus the three
// positions that have no quantity but are still allocations.
func allocationKeys() []string {
	keys := append([]string{}, domain.Sleeves...)
	return append(keys, "fd", "epf", "liquid")
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	target, err := s.store.TargetAllocation(r.Context())
	if err != nil {
		s.fail(w, "read settings", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"target_allocation": target,
		"allowed_keys":      allocationKeys(),
	})
}

// putTargetAllocation replaces the target.
//
// Validated rather than trusted, because a target that does not total 100 does
// not fail loudly — it silently rescales every drift figure in the table, and
// the numbers still look plausible. Getting this wrong by hand in psql is easy;
// that is what the endpoint is for.
func (s *Server) putTargetAllocation(w http.ResponseWriter, r *http.Request) {
	var target map[string]float64
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10))
	if err := dec.Decode(&target); err != nil {
		writeError(w, http.StatusBadRequest,
			`invalid JSON — send a flat object of percentages, e.g. {"in_equity":27,"in_mf":35,…}`)
		return
	}
	if len(target) == 0 {
		writeError(w, http.StatusBadRequest, "target allocation is empty")
		return
	}

	allowed := allocationKeys()
	var unknown []string
	total := 0.0
	for k, v := range target {
		if !slices.Contains(allowed, k) {
			unknown = append(unknown, k)
		}
		if v < 0 {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("%s is negative (%g)", k, v))
			return
		}
		total += v
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		writeError(w, http.StatusBadRequest, fmt.Sprintf(
			"unknown key(s) %s — allowed: %s",
			strings.Join(unknown, ", "), strings.Join(allowed, ", ")))
		return
	}
	// A hundredth of a point of float slop is fine; a whole point is a typo.
	if math.Abs(total-100) > 0.01 {
		writeError(w, http.StatusBadRequest, fmt.Sprintf(
			"percentages total %g, not 100 — every drift figure is a share of the whole, "+
				"so a target that does not add up rescales the entire table without failing", total))
		return
	}

	if err := s.store.SetTargetAllocation(r.Context(), target); err != nil {
		s.fail(w, "write target allocation", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"target_allocation": target})
}
