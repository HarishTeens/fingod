package httpapi

import (
	"net/http"
	"sort"

	"github.com/harishteens/fingod/api/internal/compute"
	"github.com/harishteens/fingod/api/internal/store"
)

// getCompare returns every comparable line indexed to 100, owned and benchmark
// alike, on one time-weighted basis.
//
// Time-weighted is the point. A raw value chart credits a SIP as if the market
// had delivered it, so a fund receiving 50k a month climbs whatever it does —
// and beside the Nifty that reads as outperformance. TWRR strips the
// contribution out, which is the only way the two lines mean the same thing.
func (s *Server) getCompare(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	from, to := q.Get("from"), q.Get("to")

	owned, ownedKeys, err := s.store.ReconstructSeries(r.Context(), from, to)
	if err != nil {
		s.fail(w, "reconstruct series", err)
		return
	}
	bench, benchKeys, err := s.store.BenchmarkSeries(r.Context(), from, to)
	if err != nil {
		s.fail(w, "load benchmarks", err)
		return
	}

	summaries := make([]*compute.SeriesSummary, 0, len(ownedKeys)+len(benchKeys))
	for _, k := range append(append([]store.SeriesKey{}, ownedKeys...), benchKeys...) {
		pts, ok := owned[k.Key]
		if !ok {
			pts = bench[k.Key]
		}
		if sum := compute.SummariseSeries(k.Key, k.Label, k.Kind, compute.TWRR(pts)); sum != nil {
			summaries = append(summaries, sum)
		}
	}

	// Portfolio first, then benchmarks, then the rest by return — the reading
	// order is "how did I do, against what, and which part drove it".
	rank := map[string]int{"portfolio": 0, "benchmark": 1, "sleeve": 2, "fund": 3}
	sort.SliceStable(summaries, func(i, j int) bool {
		if rank[summaries[i].Kind] != rank[summaries[j].Kind] {
			return rank[summaries[i].Kind] < rank[summaries[j].Kind]
		}
		return compute.FloatOf(summaries[i].ReturnPct) > compute.FloatOf(summaries[j].ReturnPct)
	})

	var covered string
	if len(summaries) > 0 {
		covered = summaries[0].From + " to " + summaries[0].To
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"series":  summaries,
		"count":   len(summaries),
		"covered": covered,
		"basis":   "time-weighted",
		"note": "Every line is indexed to 100 at the first date it has a position, and returns " +
			"are time-weighted: each day is credited only with what the market did, after the " +
			"day's contributions are subtracted. Without that a SIP would read as performance " +
			"and any fund you were buying into would appear to beat the index. Values come from " +
			"the order tape priced at each day's close, so the history runs from the first " +
			"recorded trade rather than from the first checkpoint. A line starts late because " +
			"the position did, not because data is missing.",
	})
}

