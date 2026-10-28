package store

import (
	"context"
	"fmt"

	"github.com/harishteens/fingod/api/internal/domain"
)

// DividendCategory is Wallet's own category. It holds interest *and* dividends
// together, which is why the label below is doing the real work.
const DividendCategory = "Interest, dividends"

// A dividend is a record in that category carrying the Investment label.
//
// The label is the whole discriminator, and it is not a heuristic — the owner
// tags them, and the notes confirm it: the labelled rows name stocks while the
// unlabelled ones say "FD interest",
// "Credit card interest", "Credit Interest".
//
// That distinction is load-bearing rather than tidy. FD interest is already
// counted, computed from rate and elapsed time and reported as accrued in
// NW_total. Sweeping the whole category into realised profit would count it
// twice — FD interest across a couple of records, plus bank and card interest
// that is not investment return at all.
func (s *Store) Dividends(ctx context.Context, from, to *domain.Date) ([]domain.Dividend, error) {
	args := []any{DividendCategory, InvestmentLabel}
	where := ""
	add := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}
	if from != nil {
		where += " AND t.txn_date >= " + add(from.String()) + "::text::date"
	}
	if to != nil {
		where += " AND t.txn_date <= " + add(to.String()) + "::text::date"
	}

	rows, err := s.pool.Query(ctx, `
		SELECT t.txn_date::text, t.amount_inr::text, COALESCE(t.account,''), COALESCE(t.note,'')
		  FROM transactions t
		 WHERE t.category = $1
		   AND t.amount_inr > 0
		   AND NOT t.is_transfer
		   AND EXISTS (SELECT 1 FROM transaction_labels l
		                WHERE l.transaction_id = t.id AND l.label = $2)`+where+`
		 ORDER BY t.txn_date DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.Dividend{}
	for rows.Next() {
		var d domain.Dividend
		var date string
		if err := rows.Scan(&date, &d.AmountINR, &d.Account, &d.Note); err != nil {
			return nil, err
		}
		if d.Date, err = domain.ParseDate(date); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
