package store

import (
	"context"
	"fmt"

	"github.com/harishteens/fingod/api/internal/domain"
)

// netCell is one period's net for one label: what that label cost after money
// that came back under the same label is subtracted.
type netCell struct {
	Period string
	Label  string
	Net    domain.Num // positive = cost you money, negative = more came back than went out
}

// labelNetSQL is the one query both the chart and the headline series read, so
// a bar and the number above it can never disagree.
//
// Three rules, and the third is the one worth reading twice:
//
//  1. Expenses count, always — untagged ones land in Untagged.
//  2. Income counts **only if it carries a label**. You tag a friend paying
//     you back with the same label as the outing; your salary is untagged. If
//     unlabelled income participated, a month's salary would land in Untagged
//     and drive the whole chart negative.
//  3. A record's amount is split across its labels after modifier labels step
//     aside, exactly as the gross version does, so the parts still sum to the
//     whole.
const labelNetSQL = `
	WITH rows AS (
	    SELECT t.id, t.txn_date, -t.amount_inr AS amt, (t.amount_inr < 0) AS is_expense
	      FROM transactions t
	     WHERE NOT t.is_transfer
	       AND t.amount_inr <> 0
	       AND COALESCE(t.category_top, '') <> $2
	       AND COALESCE(t.category_id, '') <> $4
	       AND NOT (COALESCE(t.category, '') <> 'Insurances'
	                AND EXISTS (SELECT 1 FROM transaction_labels l
	                             WHERE l.transaction_id = t.id AND l.label = $3))
	       %s
	), tagged AS (
	    -- The Investment label is an accounting marker, not a spending
	    -- category, so it never names a bucket. It reaches this query at all
	    -- only because insurance premiums carry it and are spend; those land
	    -- in Untagged, which is what an unlabelled premium is.
	    SELECT r.id, l.label
	      FROM rows r JOIN transaction_labels l ON l.transaction_id = r.id
	     WHERE l.label <> $3
	), eligible AS (
	    -- Expenses always count. Income counts only when it carries a real
	    -- label, because that is how you mark a friend paying you back —
	    -- your salary is untagged, and letting it in would drive the chart
	    -- negative.
	    SELECT r.* FROM rows r
	     WHERE r.is_expense
	        OR EXISTS (SELECT 1 FROM tagged t WHERE t.id = r.id)
	), effective AS (
	    SELECT t.id, t.label FROM tagged t
	     WHERE NOT (t.label = ANY($6))
	        OR NOT EXISTS (SELECT 1 FROM tagged o WHERE o.id = t.id AND NOT (o.label = ANY($6)))
	), counts AS (
	    SELECT id, count(*) AS n FROM effective GROUP BY id
	), exploded AS (
	    SELECT e.txn_date, COALESCE(f.label, $5) AS label, e.amt / COALESCE(c.n, 1) AS amt
	      FROM eligible e
	      LEFT JOIN effective f ON f.id = e.id
	      LEFT JOIN counts c ON c.id = e.id
	)
	SELECT to_char(date_trunc($1, txn_date), 'YYYY-MM-DD'), label, round(sum(amt), 2)::text
	  FROM exploded GROUP BY 1, 2`

// labelNets runs it for a granularity and range.
func (s *Store) labelNets(ctx context.Context, granularity string, from, to *domain.Date) ([]netCell, error) {
	unit := "month"
	if granularity == "week" {
		unit = "week"
	}
	args := []any{unit, InvestmentCategory, InvestmentLabel, TransferCategoryID, UntaggedLabel, ModifierLabels}
	where := ""
	if from != nil {
		args = append(args, from.String())
		where += fmt.Sprintf(" AND t.txn_date >= $%d::text::date", len(args))
	}
	if to != nil {
		args = append(args, to.String())
		where += fmt.Sprintf(" AND t.txn_date <= $%d::text::date", len(args))
	}

	rows, err := s.pool.Query(ctx, fmt.Sprintf(labelNetSQL, where), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []netCell{}
	for rows.Next() {
		var c netCell
		if err := rows.Scan(&c.Period, &c.Label, &c.Net); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
