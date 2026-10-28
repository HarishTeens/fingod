package httpapi

import (
	"net/http"

	"github.com/gorilla/mux"
	"github.com/harishteens/fingod/api/internal/compute"
	"github.com/harishteens/fingod/api/internal/domain"
)

// sleevesResponse deliberately separates the two kinds of "performance", because
// they need different amounts of history and mean different things.
//
//	returns      since inception, from cost basis. One checkpoint is enough.
//	attribution  market / flow / fx across the range. Needs two, and is the only
//	             one that can tell a gain from a contribution.
type sleevesResponse struct {
	AsOf        domain.Date            `json:"as_of"`
	ComparedTo  *domain.Date           `json:"compared_to"`
	Checkpoints int                    `json:"checkpoints_in_range"`
	Sleeves     []compute.SleeveReturn `json:"sleeves"`
	Total       *compute.Return        `json:"total"`
	Series      []sleevePoint          `json:"series"`
	Note        string                 `json:"note,omitempty"`
}

type sleevePoint struct {
	AsOf   string                `json:"as_of"`
	Values map[string]domain.Num `json:"values"`
}

func (s *Server) getSleeves(w http.ResponseWriter, r *http.Request) {
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
	if len(checkpoints) == 0 {
		writeError(w, http.StatusNotFound, "no checkpoint in that range — take one with /refresh")
		return
	}

	latest := checkpoints[len(checkpoints)-1]

	// The comparison is the *first* checkpoint in range, so ?from= is what
	// picks the period: a week ago for weekly, a year ago for yearly. One
	// parameter, no separate mode.
	var prev []domain.Holding
	var comparedTo *domain.Date
	if len(checkpoints) > 1 {
		base := checkpoints[0]
		prev = base.Holdings
		comparedTo = &base.AsOfDate
	}

	threshold, err := s.store.FlowFlagThreshold(r.Context())
	if err != nil {
		s.fail(w, "read settings", err)
		return
	}

	sleeves, total, err := compute.Returns(latest.Holdings, prev, threshold)
	if err != nil {
		s.fail(w, "compute returns", err)
		return
	}

	// Fixed deposits are an asset class with a target allocation, so they belong
	// on this page — but they are standing rows, not holdings, so they are
	// valued rather than snapshotted and folded in here.
	fds, err := s.store.FixedDeposits(r.Context(), true)
	if err != nil {
		s.fail(w, "read fixed deposits", err)
		return
	}
	fdSleeve, err := compute.FixedDepositReturns(fds, latest.AsOfDate, comparedTo)
	if err != nil {
		s.fail(w, "value fixed deposits", err)
		return
	}
	if len(fdSleeve.Holdings) > 0 {
		sleeves = insertByValue(sleeves, *fdSleeve)
		total = addReturn(total, fdSleeve.Return)
	}

	targets, err := s.store.PriceTargets(r.Context())
	if err != nil {
		s.fail(w, "read price targets", err)
		return
	}
	if err := compute.ApplyTargets(sleeves, targets); err != nil {
		s.fail(w, "apply price targets", err)
		return
	}

	series := make([]sleevePoint, 0, len(checkpoints))
	for _, cp := range checkpoints {
		vals := map[string]domain.Num{}
		for _, h := range cp.Holdings {
			vals[h.Sleeve] = compute.AddMoneyStrings(vals[h.Sleeve], h.ValueINR)
		}
		// Valued at each checkpoint's own date, which is the point of storing
		// deposits as standing rows: one entered today prices correctly at a
		// checkpoint taken before it existed.
		if fdAt, err := compute.FixedDepositReturns(fds, cp.AsOfDate, nil); err == nil {
			if len(fdAt.Holdings) > 0 {
				vals[compute.SleeveFD] = fdAt.Value
			}
		}
		series = append(series, sleevePoint{AsOf: cp.AsOfDate.String(), Values: vals})
	}

	resp := sleevesResponse{
		AsOf:        latest.AsOfDate,
		ComparedTo:  comparedTo,
		Checkpoints: len(checkpoints),
		Sleeves:     sleeves,
		Total:       total,
		Series:      series,
	}
	if comparedTo == nil {
		resp.Note = "Only one checkpoint in range, so there is nothing to diff: returns are " +
			"since inception, from cost basis. The market / flow / fx split needs a second " +
			"checkpoint, which is what makes a rise in value legible as gain rather than money added."
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) getSleeveHoldings(w http.ResponseWriter, r *http.Request) {
	sleeve := mux.Vars(r)["sleeve"]
	found := sleeve == compute.SleeveFD
	for _, s := range domain.Sleeves {
		if s == sleeve {
			found = true
		}
	}
	if !found {
		writeError(w, http.StatusNotFound, "no such sleeve: "+sleeve)
		return
	}

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
	if len(checkpoints) == 0 {
		writeError(w, http.StatusNotFound, "no checkpoint in that range")
		return
	}
	latest := checkpoints[len(checkpoints)-1]

	var prev []domain.Holding
	var comparedTo *domain.Date
	if len(checkpoints) > 1 {
		prev = checkpoints[0].Holdings
		comparedTo = &checkpoints[0].AsOfDate
	}

	threshold, err := s.store.FlowFlagThreshold(r.Context())
	if err != nil {
		s.fail(w, "read settings", err)
		return
	}
	sleeves, _, err := compute.Returns(latest.Holdings, prev, threshold)
	if err != nil {
		s.fail(w, "compute returns", err)
		return
	}
	targets, err := s.store.PriceTargets(r.Context())
	if err != nil {
		s.fail(w, "read price targets", err)
		return
	}
	if err := compute.ApplyTargets(sleeves, targets); err != nil {
		s.fail(w, "apply price targets", err)
		return
	}

	if sleeve == compute.SleeveFD {
		fds, err := s.store.FixedDeposits(r.Context(), true)
		if err != nil {
			s.fail(w, "read fixed deposits", err)
			return
		}
		fdSleeve, err := compute.FixedDepositReturns(fds, latest.AsOfDate, comparedTo)
		if err != nil {
			s.fail(w, "value fixed deposits", err)
			return
		}
		sleeves = append(sleeves, *fdSleeve)
	}

	for _, sr := range sleeves {
		if sr.Sleeve == sleeve {
			writeJSON(w, http.StatusOK, map[string]any{
				"as_of":       latest.AsOfDate.String(),
				"compared_to": comparedTo,
				"sleeve":      sr,
			})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"as_of":  latest.AsOfDate.String(),
		"sleeve": map[string]any{"sleeve": sleeve, "holdings": []any{}},
		"note":   "nothing held in this sleeve at that checkpoint",
	})
}

// insertByValue keeps the sleeve list ordered largest first, which is how the
// page reads it.
func insertByValue(list []compute.SleeveReturn, row compute.SleeveReturn) []compute.SleeveReturn {
	v := compute.FloatOf(row.Value)
	for i := range list {
		if compute.FloatOf(list[i].Value) < v {
			return append(list[:i], append([]compute.SleeveReturn{row}, list[i:]...)...)
		}
	}
	return append(list, row)
}

// addReturn folds a sleeve into the page total. Percentages are recomputed from
// the summed rupees rather than averaged, because an average of percentages
// weights a ₹50k sleeve the same as a ₹10L one.
func addReturn(total *compute.Return, add compute.Return) *compute.Return {
	value := compute.AddMoneyStrings(total.Value, add.Value)
	invested := compute.AddMoneyStrings(total.Invested, add.Invested)
	out := compute.Return{
		Value:      value,
		Invested:   invested,
		Unrealised: compute.SubMoneyStrings(value, invested),
		Partial:    total.Partial || add.Partial,
	}
	if compute.FloatOf(invested) != 0 {
		out.ReturnPct = compute.PctOf(out.Unrealised, invested)
	}
	return &out
}

// getProjection answers "what if every target were reached".
//
// Its own endpoint rather than a field on /sleeves, because it is a different
// kind of number: everything else the API returns is an observation, and this
// is a hypothesis. Keeping them apart makes it harder to accidentally add one
// to the other.
func (s *Server) getProjection(w http.ResponseWriter, r *http.Request) {
	checkpoints, err := s.store.CheckpointsWithDetail(r.Context(), nil, nil)
	if err != nil {
		s.fail(w, "read checkpoints", err)
		return
	}
	if len(checkpoints) == 0 {
		writeError(w, http.StatusNotFound, "no checkpoint to project from")
		return
	}
	latest := checkpoints[len(checkpoints)-1]

	threshold, err := s.store.FlowFlagThreshold(r.Context())
	if err != nil {
		s.fail(w, "read settings", err)
		return
	}
	sleeves, _, err := compute.Returns(latest.Holdings, nil, threshold)
	if err != nil {
		s.fail(w, "compute returns", err)
		return
	}
	targets, err := s.store.PriceTargets(r.Context())
	if err != nil {
		s.fail(w, "read price targets", err)
		return
	}
	if err := compute.ApplyTargets(sleeves, targets); err != nil {
		s.fail(w, "apply price targets", err)
		return
	}

	projection, err := compute.Project(sleeves)
	if err != nil {
		s.fail(w, "project targets", err)
		return
	}

	// The track record is the honest counterweight: this scenario assumes every
	// remaining position hits, and the closed ones did not.
	trades, err := s.store.Trades(r.Context(), "", nil, nil)
	if err != nil {
		s.fail(w, "read trades", err)
		return
	}
	record, err := compute.Summarise(trades)
	if err != nil {
		s.fail(w, "summarise trades", err)
		return
	}
	projection.Realised = record.Realised

	writeJSON(w, http.StatusOK, map[string]any{
		"as_of":        latest.AsOfDate.String(),
		"projection":   projection,
		"track_record": record,
		"note": "Not a forecast. Arithmetic on prices the owner chose, whose only claim is internal " +
			"consistency. It assumes every remaining position reaches its target, while the closed " +
			"ones managed " + record.WinRatePct.String() + "% — and it has no time horizon, so a " +
			"target six months out and one three years out count the same.",
	})
}
