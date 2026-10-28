package store

import (
	"context"
	"fmt"

	"github.com/harishteens/fingod/api/internal/domain"
)

// UpsertPrices writes daily closes idempotently on (instrument, on_date).
//
// Re-fetching an overlapping window has to be free, because the alternative is
// tracking exactly which days are already loaded and getting it wrong once.
func (s *Store) UpsertPrices(ctx context.Context, prices []domain.Price) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	n := 0
	for _, p := range prices {
		_, err := tx.Exec(ctx, `
			INSERT INTO price_history (instrument, on_date, close, currency, source)
			VALUES ($1, $2::text::date, $3::text::numeric, $4, $5)
			ON CONFLICT (instrument, on_date) DO UPDATE
			    SET close = EXCLUDED.close, currency = EXCLUDED.currency,
			        source = EXCLUDED.source`,
			p.Instrument, p.OnDate.String(), p.Close.String(), p.Currency, p.Source)
		if err != nil {
			return n, fmt.Errorf("price %s on %s: %w", p.Instrument, p.OnDate, err)
		}
		n++
	}
	return n, tx.Commit(ctx)
}

// PriceCoverage lists every instrument that needs prices and what it has.
func (s *Store) PriceCoverage(ctx context.Context) ([]domain.PriceCoverage, error) {
	rows, err := s.pool.Query(ctx, `
		WITH needed AS (
		    -- Mutual funds are keyed by ISIN, so symbol IS the ISIN and makes a
		    -- useless label; the readable fund name lives in name. Equities have
		    -- it the other way round.
		    SELECT DISTINCT COALESCE(NULLIF(o.isin,''), o.symbol) AS instrument,
		           COALESCE(NULLIF(o.name,''), o.symbol) AS label, o.sleeve
		      FROM orders o
		     WHERE o.sleeve IN ('in_equity','in_mf','us_equity','gold','debt','btc')
		    UNION ALL
		    SELECT b.key, b.label, 'benchmark' FROM benchmarks b
		)
		SELECT n.instrument, max(n.label), max(n.sleeve),
		       count(p.on_date)::int,
		       COALESCE(min(p.on_date)::text,''), COALESCE(max(p.on_date)::text,'')
		  FROM needed n
		  LEFT JOIN price_history p ON p.instrument = n.instrument
		 GROUP BY n.instrument
		 ORDER BY count(p.on_date), max(n.sleeve), n.instrument`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.PriceCoverage{}
	for rows.Next() {
		var c domain.PriceCoverage
		if err := rows.Scan(&c.Instrument, &c.Label, &c.Sleeve, &c.Bars, &c.First, &c.Last); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
