package httpapi

import (
	"errors"
	"net/http"

	"github.com/harishteens/fingod/api/internal/compute"
	"github.com/harishteens/fingod/api/internal/domain"
)

// dateParam reads an optional YYYY-MM-DD query parameter.
func dateParam(r *http.Request, key string) (*domain.Date, error) {
	v := r.URL.Query().Get(key)
	if v == "" {
		return nil, nil
	}
	d, err := domain.ParseDate(v)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// series computes net worth at every checkpoint in a range. Positions come from
// the checkpoint; fixed deposits are standing rows valued at each checkpoint's
// own date, which is what lets an FD entered today price correctly at a
// checkpoint taken before it existed.
func (s *Server) series(r *http.Request) ([]*compute.NetWorth, error) {
	from, err := dateParam(r, "from")
	if err != nil {
		return nil, err
	}
	to, err := dateParam(r, "to")
	if err != nil {
		return nil, err
	}

	checkpoints, err := s.store.CheckpointsWithDetail(r.Context(), from, to)
	if err != nil {
		return nil, err
	}
	fds, err := s.store.FixedDeposits(r.Context(), true)
	if err != nil {
		return nil, err
	}

	out := make([]*compute.NetWorth, 0, len(checkpoints))
	for _, cp := range checkpoints {
		nw, err := compute.Compute(compute.NetWorthInput{
			AsOf:          cp.AsOfDate,
			Holdings:      positionsOf(cp),
			Balances:      cp.Balances,
			FixedDeposits: fds,
		})
		if err != nil {
			return nil, err
		}
		out = append(out, nw)
	}
	return out, nil
}

func positionsOf(cp domain.Checkpoint) []compute.Position {
	out := make([]compute.Position, 0, len(cp.Holdings))
	for _, h := range cp.Holdings {
		out = append(out, compute.Position{
			Sleeve: h.Sleeve, Symbol: h.Symbol, Name: h.Name, ISIN: h.ISIN,
			Qty: h.Qty, Price: h.Price, FXRate: h.FXRate, Currency: h.Currency,
		})
	}
	return out
}

func (s *Server) getNetworth(w http.ResponseWriter, r *http.Request) {
	series, err := s.series(r)
	if err != nil {
		var invalid domain.InvalidError
		if errors.As(err, &invalid) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		s.fail(w, "compute net worth", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"series": series,
		"count":  len(series),
	})
}

func (s *Server) getAllocation(w http.ResponseWriter, r *http.Request) {
	series, err := s.series(r)
	if err != nil {
		s.fail(w, "compute allocation", err)
		return
	}
	if len(series) == 0 {
		writeError(w, http.StatusNotFound, "no checkpoint to allocate — take one with /refresh")
		return
	}
	// Allocation is a point-in-time view: the newest checkpoint in range, or
	// the one at ?at= if given.
	nw := series[len(series)-1]

	target, err := s.store.TargetAllocation(r.Context())
	if err != nil {
		s.fail(w, "read target allocation", err)
		return
	}
	alloc, err := compute.Allocate(nw, target)
	if err != nil {
		s.fail(w, "compute allocation", err)
		return
	}
	writeJSON(w, http.StatusOK, alloc)
}

func (s *Server) getExpenses(w http.ResponseWriter, r *http.Request) {
	granularity := r.URL.Query().Get("granularity")
	if granularity == "" {
		granularity = "month"
	}
	if granularity != "month" && granularity != "week" {
		writeError(w, http.StatusBadRequest, `granularity must be "month" or "week"`)
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

	if r.URL.Query().Get("by") == "label" {
		buckets, series, err := s.store.ExpenseByLabel(r.Context(), granularity, from, to, 8)
		if err != nil {
			s.fail(w, "compute expense breakdown", err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"granularity": granularity,
			"by":          "label",
			"series":      buckets,
			"labels":      series,
			"count":       len(buckets),
			"note": "Labels are many-to-many, so a record carrying two is split evenly between " +
				"them — the segments sum to the period's spend exactly, which is what a stacked " +
				"bar has to guarantee. Untagged is always emitted; labels past the palette's " +
				"capacity fold into Other.",
		})
		return
	}

	buckets, err := s.store.ExpenseSeries(r.Context(), granularity, from, to)
	if err != nil {
		s.fail(w, "compute expense series", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"granularity": granularity,
		"series":      buckets,
		"count":       len(buckets),
		"note": "spend excludes transfers between own accounts, Wallet's Investments category, " +
			"and anything carrying the Investment label; investments is reported separately " +
			"because it is contribution, not consumption",
	})
}
