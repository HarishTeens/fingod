package store

import (
	"context"
	"fmt"

	"github.com/harishteens/fingod/api/internal/domain"
)

// ReplaceUSCostBasis swaps in a whole new open-position set atomically.
//
// Delete-then-insert inside one transaction, because the importer has read the
// complete order book and its answer is the whole truth. Upserting instead
// would strand a fully-sold symbol in the table forever, still asserting a cost
// basis for shares that no longer exist.
func (s *Store) ReplaceUSCostBasis(ctx context.Context, b domain.USCostBasisBatch) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Rates first: they are the evidence for the cost basis about to land, and
	// they accumulate rather than get replaced — an old trade's rate stays true
	// even once that position is closed.
	for _, f := range b.FXRates {
		asOf := f.OnDate.String()
		if f.AsOf != nil {
			asOf = f.AsOf.String()
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO fx_rates (on_date, usd_inr, as_of, source)
			VALUES ($1::text::date, $2::text::numeric, $3::text::date, $4)
			ON CONFLICT (on_date) DO UPDATE
			    SET usd_inr = EXCLUDED.usd_inr, as_of = EXCLUDED.as_of, source = EXCLUDED.source`,
			f.OnDate.String(), f.USDINR.String(), asOf, f.Source)
		if err != nil {
			return 0, fmt.Errorf("record fx rate %s: %w", f.OnDate, err)
		}
	}

	if _, err := tx.Exec(ctx, `DELETE FROM us_cost_basis`); err != nil {
		return 0, fmt.Errorf("clear us cost basis: %w", err)
	}
	for _, p := range b.Positions {
		_, err := tx.Exec(ctx, `
			INSERT INTO us_cost_basis (symbol, qty, cost_usd, cost_inr, first_buy, source, updated_at)
			VALUES ($1, $2::text::numeric, $3::text::numeric, $4::text::numeric,
			        NULLIF($5,'')::date, $6, now())`,
			p.Symbol, p.Qty.String(), p.CostUSD.String(), p.CostINR.String(),
			dateOrEmpty(p.FirstBuy), p.Source)
		if err != nil {
			return 0, fmt.Errorf("insert us cost basis %s: %w", p.Symbol, err)
		}
	}
	// Correct history too. A position's cost basis is a fact about the position,
	// not about the day it was observed, so every checkpoint whose quantity
	// still matches gets the corrected figure rather than only future ones.
	//
	// Where the quantity does NOT match, the basis is set to NULL instead of
	// left alone: whatever is in there came from INDmoney's flat-92 field, and
	// a number known to be derived from a discredited source is worse than a
	// blank. It reads as "unknown" in the UI, which is the truth.
	if _, err := tx.Exec(ctx, `
		UPDATE holdings h
		   SET invested_inr = b.cost_inr, invested_usd = b.cost_usd
		  FROM us_cost_basis b
		 WHERE h.sleeve = 'us_equity' AND b.symbol = h.symbol
		   AND abs(b.qty - h.qty) <= 0.000001`); err != nil {
		return 0, fmt.Errorf("backfill us holdings cost basis: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE holdings h
		   SET invested_inr = NULL, invested_usd = NULL
		 WHERE h.sleeve = 'us_equity'
		   AND NOT EXISTS (SELECT 1 FROM us_cost_basis b
		                    WHERE b.symbol = h.symbol
		                      AND abs(b.qty - h.qty) <= 0.000001)`); err != nil {
		return 0, fmt.Errorf("clear unbacked us holdings cost basis: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(b.Positions), nil
}

const usCostBasisColumns = `symbol, qty::text, cost_usd::text, cost_inr::text,
	COALESCE(buy_rate::text,''), COALESCE(first_buy::text,''), source, updated_at::text`

// USCostBasis lists every open US position's cost basis, richest first.
func (s *Store) USCostBasis(ctx context.Context) ([]domain.USCostBasis, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+usCostBasisColumns+`
		  FROM us_cost_basis
		 ORDER BY cost_inr DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []domain.USCostBasis
	for rows.Next() {
		var p domain.USCostBasis
		var buyRate, firstBuy string
		if err := rows.Scan(&p.Symbol, &p.Qty, &p.CostUSD, &p.CostINR,
			&buyRate, &firstBuy, &p.Source, &p.UpdatedAt); err != nil {
			return nil, err
		}
		p.BuyRate = domain.Num(buyRate)
		if firstBuy != "" {
			d, err := domain.ParseDate(firstBuy)
			if err != nil {
				return nil, fmt.Errorf("us_cost_basis %s first_buy: %w", p.Symbol, err)
			}
			p.FirstBuy = &d
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// FXRates returns every recorded conversion rate, newest first.
func (s *Store) FXRates(ctx context.Context) ([]domain.FXRate, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT on_date::text, usd_inr::text, as_of::text, source
		  FROM fx_rates ORDER BY on_date DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []domain.FXRate
	for rows.Next() {
		var onDate, asOf string
		var f domain.FXRate
		if err := rows.Scan(&onDate, &f.USDINR, &asOf, &f.Source); err != nil {
			return nil, err
		}
		d, err := domain.ParseDate(onDate)
		if err != nil {
			return nil, err
		}
		f.OnDate = d
		if a, err := domain.ParseDate(asOf); err == nil {
			f.AsOf = &a
		}
		out = append(out, f)
	}
	return out, rows.Err()
}
