package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/harishteens/fingod/api/internal/domain"
)

// ExpenseFilter narrows a drill-down. Zero fields mean no narrowing.
type ExpenseFilter struct {
	Period      domain.Date // first day of the period
	Granularity string      // month | week
	CategoryTop string
	Category    string
	Label       string
}

// BreakdownRow is one line of a drill-down level.
type BreakdownRow struct {
	Key    string     `json:"key"`
	Amount domain.Num `json:"amount"`
	Count  int        `json:"count"`
	Color  string     `json:"color,omitempty"` // Wallet's own category colour
}

// TransactionRow is one record in the deepest level of the drill-down.
type TransactionRow struct {
	ID          string     `json:"id"`
	Date        string     `json:"date"`
	Amount      domain.Num `json:"amount"` // positive: this is spend
	Account     string     `json:"account"`
	Note        string     `json:"note,omitempty"`
	Category    string     `json:"category,omitempty"`
	CategoryTop string     `json:"category_top,omitempty"`
	Color       string     `json:"color,omitempty"`
	Labels      []string   `json:"labels,omitempty"`
}

// spendScope is the WHERE every expense view shares: real spending only.
//
// Kept in one place because the three exclusions — transfers, the Investments
// category, the Investment label — were each added after a number looked wrong,
// and a drill-down that disagreed with the chart above it would be worse than
// either being wrong alone.
func (f ExpenseFilter) spendScope(args *[]any) string {
	add := func(v any) string {
		*args = append(*args, v)
		return fmt.Sprintf("$%d", len(*args))
	}

	unit := "month"
	if f.Granularity == "week" {
		unit = "week"
	}
	period := add(f.Period.String())
	interval := add("1 " + unit)

	where := []string{
		"NOT t.is_transfer",
		"t.amount_inr < 0",
		"t.txn_date >= " + period + "::text::date",
		"t.txn_date < " + period + "::text::date + " + interval + "::interval",
		"COALESCE(t.category_top, '') <> " + add(InvestmentCategory),
		"COALESCE(t.category_id, '') <> " + add(TransferCategoryID),
		"NOT (COALESCE(t.category, '') <> 'Insurances' AND EXISTS (SELECT 1 FROM transaction_labels l WHERE l.transaction_id = t.id AND l.label = " + add(InvestmentLabel) + "))",
	}
	if f.CategoryTop != "" {
		where = append(where, "COALESCE(t.category_top, '') = "+add(f.CategoryTop))
	}
	if f.Category != "" {
		where = append(where, "COALESCE(t.category, '') = "+add(f.Category))
	}
	if f.Label != "" {
		if f.Label == UntaggedLabel {
			where = append(where, "NOT EXISTS (SELECT 1 FROM transaction_labels l WHERE l.transaction_id = t.id)")
		} else {
			where = append(where, "EXISTS (SELECT 1 FROM transaction_labels l WHERE l.transaction_id = t.id AND l.label = "+add(f.Label)+")")
		}
	}
	return strings.Join(where, "\n           AND ")
}

// ExpenseBreakdown groups a period's spend one level at a time.
//
// `by` is category (top level), subcategory (the leaf), or label. The first two
// are a true partition — every record has exactly one of each. Labels are not,
// so they reuse the chart's rule: a modifier label steps aside, and anything
// still sharing divides evenly. That keeps the drill-down adding up to the bar
// the user clicked, which is the whole reason they clicked it.
func (s *Store) ExpenseBreakdown(ctx context.Context, f ExpenseFilter, by string) ([]BreakdownRow, domain.Num, int, error) {
	args := []any{}
	scope := f.spendScope(&args)

	var q string
	switch by {
	case "label":
		args = append(args, UntaggedLabel, ModifierLabels)
		untagged := fmt.Sprintf("$%d", len(args)-1)
		modifiers := fmt.Sprintf("$%d", len(args))
		q = `
		WITH spend AS (
		    SELECT t.id, -t.amount_inr AS amt FROM transactions t WHERE ` + scope + `
		), tagged AS (
		    SELECT s.id, l.label FROM spend s JOIN transaction_labels l ON l.transaction_id = s.id
		), effective AS (
		    SELECT t.id, t.label FROM tagged t
		     WHERE NOT (t.label = ANY(` + modifiers + `))
		        OR NOT EXISTS (SELECT 1 FROM tagged o WHERE o.id = t.id AND NOT (o.label = ANY(` + modifiers + `)))
		), counts AS (
		    SELECT id, count(*) AS n FROM effective GROUP BY id
		)
		SELECT COALESCE(e.label, ` + untagged + `) AS k,
		       round(sum(s.amt / COALESCE(c.n, 1)), 2)::text,
		       count(*), ''
		  FROM spend s
		  LEFT JOIN effective e ON e.id = s.id
		  LEFT JOIN counts c ON c.id = s.id
		 GROUP BY 1
		 -- Not "ORDER BY 2::numeric": the ordinal stops being an ordinal the
		 -- moment it is cast, and becomes the constant two, sorting nothing.
		 ORDER BY sum(s.amt / COALESCE(c.n, 1)) DESC`

	case "subcategory":
		q = `
		SELECT COALESCE(NULLIF(t.category, ''), 'Uncategorised'),
		       round(sum(-t.amount_inr), 2)::text, count(*),
		       COALESCE(max(t.raw->'category'->>'color'), '')
		  FROM transactions t WHERE ` + scope + `
		 GROUP BY 1 ORDER BY sum(-t.amount_inr) DESC`

	default: // category
		q = `
		SELECT COALESCE(NULLIF(t.category_top, ''), 'Uncategorised'),
		       round(sum(-t.amount_inr), 2)::text, count(*),
		       COALESCE(max(t.raw->'category'->>'color'), '')
		  FROM transactions t WHERE ` + scope + `
		 GROUP BY 1 ORDER BY sum(-t.amount_inr) DESC`
	}

	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, "", 0, err
	}
	defer rows.Close()

	out := []BreakdownRow{}
	total := domain.Num("0.00")
	count := 0
	for rows.Next() {
		var r BreakdownRow
		if err := rows.Scan(&r.Key, &r.Amount, &r.Count, &r.Color); err != nil {
			return nil, "", 0, err
		}
		out = append(out, r)
		if by != "label" {
			// Label rows are shares of a record, so counting them would count
			// a two-label record twice. The period total comes from the
			// partitioning levels.
			count += r.Count
		}
		total = addMoneyStr(total, r.Amount)
	}
	return out, total, count, rows.Err()
}

// ExpenseTransactions lists the records behind whatever the drill-down has
// narrowed to.
func (s *Store) ExpenseTransactions(ctx context.Context, f ExpenseFilter, limit int) ([]TransactionRow, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	args := []any{}
	scope := f.spendScope(&args)
	args = append(args, limit)

	rows, err := s.pool.Query(ctx, `
		SELECT t.id, t.txn_date::text, round(-t.amount_inr, 2)::text,
		       COALESCE(t.account, ''), COALESCE(t.note, ''),
		       COALESCE(t.category, ''), COALESCE(t.category_top, ''),
		       COALESCE(t.raw->'category'->>'color', ''),
		       COALESCE((SELECT array_agg(l.label ORDER BY l.label)
		                   FROM transaction_labels l WHERE l.transaction_id = t.id), '{}')
		  FROM transactions t
		 WHERE `+scope+`
		 ORDER BY t.amount_inr
		 LIMIT $`+itoa(len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []TransactionRow{}
	for rows.Next() {
		var r TransactionRow
		if err := rows.Scan(&r.ID, &r.Date, &r.Amount, &r.Account, &r.Note,
			&r.Category, &r.CategoryTop, &r.Color, &r.Labels); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
