package httpapi

import (
	"net/http"
	"strconv"

	"github.com/harishteens/fingod/api/internal/compute"
	"github.com/harishteens/fingod/api/internal/domain"
	"github.com/harishteens/fingod/api/internal/store"
)

// expenseFilter reads the drill-down state off the query string.
//
// The whole drill-down is URL state rather than a server-side session: a level
// you reached is a link you can send yourself, and the API stays stateless.
func expenseFilter(r *http.Request) (store.ExpenseFilter, bool) {
	q := r.URL.Query()
	period, err := domain.ParseDate(q.Get("period"))
	if err != nil {
		return store.ExpenseFilter{}, false
	}
	granularity := q.Get("granularity")
	if granularity == "" {
		granularity = "month"
	}
	if granularity != "month" && granularity != "week" {
		return store.ExpenseFilter{}, false
	}
	return store.ExpenseFilter{
		Period:      period,
		Granularity: granularity,
		CategoryTop: q.Get("category"),
		Category:    q.Get("subcategory"),
		Label:       q.Get("label"),
	}, true
}

const badFilter = `period is required as YYYY-MM-DD (the first day of the period), ` +
	`and granularity must be "month" or "week"`

func (s *Server) getBreakdown(w http.ResponseWriter, r *http.Request) {
	f, ok := expenseFilter(r)
	if !ok {
		writeError(w, http.StatusBadRequest, badFilter)
		return
	}

	by := r.URL.Query().Get("by")
	switch by {
	case "", "category":
		by = "category"
	case "subcategory", "label":
	default:
		writeError(w, http.StatusBadRequest, `by must be "category", "subcategory" or "label"`)
		return
	}

	rows, total, count, err := s.store.ExpenseBreakdown(r.Context(), f, by)
	if err != nil {
		s.fail(w, "compute expense breakdown", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"period":      f.Period.String(),
		"granularity": f.Granularity,
		"by":          by,
		"rows":        rows,
		"total":       total,
		"count":       count,
		"filter": map[string]string{
			"category": f.CategoryTop, "subcategory": f.Category, "label": f.Label,
		},
	})
}

func (s *Server) getExpenseTransactions(w http.ResponseWriter, r *http.Request) {
	f, ok := expenseFilter(r)
	if !ok {
		writeError(w, http.StatusBadRequest, badFilter)
		return
	}
	limit := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = n
	}

	rows, err := s.store.ExpenseTransactions(r.Context(), f, limit)
	if err != nil {
		s.fail(w, "list expense transactions", err)
		return
	}
	total := "0.00"
	for _, t := range rows {
		total = compute.AddMoney(total, t.Amount)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"period":       f.Period.String(),
		"granularity":  f.Granularity,
		"transactions": rows,
		"count":        len(rows),
		"total":        domain.Num(total),
	})
}
