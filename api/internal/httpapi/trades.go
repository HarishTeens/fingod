package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/gorilla/mux"
	"github.com/harishteens/fingod/api/internal/compute"
	"github.com/harishteens/fingod/api/internal/domain"
	"github.com/harishteens/fingod/api/internal/store"
)

func (s *Server) postTrades(w http.ResponseWriter, r *http.Request) {
	var batch domain.TradeBatch
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
	inserted, updated, err := s.store.UpsertTrades(r.Context(), batch.Trades)
	if err != nil {
		s.fail(w, "import trades", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"received": len(batch.Trades), "inserted": inserted, "updated": updated,
	})
}

// getRealised is the whole realised story in one response: the trades, what they
// add up to, and how that landed over time.
func (s *Server) getRealised(w http.ResponseWriter, r *http.Request) {
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
	granularity := r.URL.Query().Get("granularity")
	if granularity == "" {
		granularity = "month"
	}
	if granularity != "month" && granularity != "year" {
		writeError(w, http.StatusBadRequest, `granularity must be "month" or "year"`)
		return
	}

	trades, err := s.store.Trades(r.Context(), r.URL.Query().Get("sleeve"), from, to)
	if err != nil {
		s.fail(w, "list trades", err)
		return
	}
	summary, err := compute.Summarise(trades)
	if err != nil {
		s.fail(w, "summarise trades", err)
		return
	}
	series, err := compute.ByPeriod(trades, granularity)
	if err != nil {
		s.fail(w, "bucket trades", err)
		return
	}

	// Per sleeve, so "which book actually makes money" is answerable.
	bySleeve := map[string][]domain.Trade{}
	for _, t := range trades {
		bySleeve[t.Sleeve] = append(bySleeve[t.Sleeve], t)
	}
	sleeves := map[string]*compute.RealisedSummary{}
	for sleeve, list := range bySleeve {
		sum, err := compute.Summarise(list)
		if err != nil {
			s.fail(w, "summarise sleeve", err)
			return
		}
		sleeves[sleeve] = sum
	}

	// Dividends are the third kind of realised return — cash out of something
	// still held, so it closes nothing and cannot live in the trade table.
	divs, err := s.store.Dividends(r.Context(), from, to)
	if err != nil {
		s.fail(w, "list dividends", err)
		return
	}
	dividends, err := compute.SummariseDividends(divs, granularity)
	if err != nil {
		s.fail(w, "summarise dividends", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"summary":        summary,
		"by_sleeve":      sleeves,
		"series":         series,
		"dividends":      dividends,
		"total_realised": compute.AddMoneyStrings(summary.Realised, dividends.Total),
		"granularity":    granularity,
		"trades":         trades,
		"note": "Trades are bucketed on the exit date: profit became real the day the position was " +
			"sold, and one held across three years did not earn a third of it in each. Dividends " +
			"are Wallet records in the \"Interest, dividends\" category carrying the Investment " +
			"label — the label matters, because the same category holds FD interest, which is " +
			"already counted as accrued and would otherwise be counted twice.",
	})
}

func (s *Server) getPriceTargets(w http.ResponseWriter, r *http.Request) {
	targets, err := s.store.PriceTargets(r.Context())
	if err != nil {
		s.fail(w, "list price targets", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"targets": targets, "count": len(targets)})
}

func (s *Server) putPriceTargets(w http.ResponseWriter, r *http.Request) {
	var batch domain.PriceTargetBatch
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&batch); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if err := batch.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	n, err := s.store.UpsertPriceTargets(r.Context(), batch.Targets)
	if err != nil {
		s.fail(w, "save price targets", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"saved": n})
}

func (s *Server) deletePriceTarget(w http.ResponseWriter, r *http.Request) {
	v := mux.Vars(r)
	err := s.store.DeletePriceTarget(r.Context(), v["sleeve"], v["symbol"])
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "no target for that holding")
		return
	}
	if err != nil {
		s.fail(w, "delete price target", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteTrade(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(mux.Vars(r)["id"], 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "id must be an integer")
		return
	}
	err = s.store.DeleteTrade(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "no trade with that id")
		return
	}
	if err != nil {
		s.fail(w, "delete trade", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
