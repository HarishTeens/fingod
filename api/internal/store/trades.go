package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/harishteens/fingod/api/internal/compute"
	"github.com/harishteens/fingod/api/internal/domain"
)

const tradeColumns = `id, sleeve, symbol, COALESCE(name,''), COALESCE(isin,''),
	COALESCE(qty::text,''), COALESCE(buy_price::text,''), COALESCE(sell_price::text,''),
	COALESCE(buy_date::text,''), exit_date::text, holding_days,
	invested_inr::text, realised_inr::text, COALESCE(note,''), source`

// UpsertTrades imports closed trades idempotently.
//
// The natural key is (sleeve, symbol, exit_date, invested_inr): re-importing the
// same journal must not double the profit, and a second sale of the same stock
// on the same day for the same amount is not a thing that happens.
func (s *Store) UpsertTrades(ctx context.Context, trades []domain.Trade) (inserted, updated int, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, t := range trades {
		var isNew bool
		err := tx.QueryRow(ctx, `
			INSERT INTO trades (sleeve, symbol, name, isin, qty, buy_price, sell_price,
			                    buy_date, exit_date, holding_days, invested_inr, realised_inr, note, source)
			VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''),
			        NULLIF($5,'')::numeric, NULLIF($6,'')::numeric, NULLIF($7,'')::numeric,
			        NULLIF($8,'')::date, $9::text::date, $10,
			        $11::text::numeric, $12::text::numeric, NULLIF($13,''), $14)
			ON CONFLICT (sleeve, symbol, exit_date, invested_inr) DO UPDATE
			    SET name = EXCLUDED.name, isin = EXCLUDED.isin, qty = EXCLUDED.qty,
			        buy_price = EXCLUDED.buy_price, sell_price = EXCLUDED.sell_price,
			        buy_date = EXCLUDED.buy_date, holding_days = EXCLUDED.holding_days,
			        realised_inr = EXCLUDED.realised_inr, note = EXCLUDED.note,
			        -- Provenance follows the data. A journal row overwritten by a
			        -- tradebook import is now a tradebook row, and leaving it
			        -- labelled otherwise makes "delete everything from the
			        -- journal" delete four rows that came from the broker.
			        source = EXCLUDED.source
			RETURNING (xmax = 0)`,
			t.Sleeve, t.Symbol, t.Name, t.ISIN,
			t.Qty.String(), t.BuyPrice.String(), t.SellPrice.String(),
			dateOrEmpty(t.BuyDate), t.ExitDate.String(), t.HoldingDays,
			t.InvestedINR.String(), t.RealisedINR.String(), t.Note, t.Source,
		).Scan(&isNew)
		if err != nil {
			return 0, 0, fmt.Errorf("upsert trade %s/%s: %w", t.Sleeve, t.Symbol, err)
		}
		if isNew {
			inserted++
		} else {
			updated++
		}
	}
	return inserted, updated, tx.Commit(ctx)
}

// Trades lists closed positions, most recent exit first.
func (s *Store) Trades(ctx context.Context, sleeve string, from, to *domain.Date) ([]domain.Trade, error) {
	args := []any{}
	where := []string{"true"}
	add := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}
	if sleeve != "" {
		where = append(where, "sleeve = "+add(sleeve))
	}
	if from != nil {
		where = append(where, "exit_date >= "+add(from.String())+"::text::date")
	}
	if to != nil {
		where = append(where, "exit_date <= "+add(to.String())+"::text::date")
	}

	rows, err := s.pool.Query(ctx, `SELECT `+tradeColumns+`
		  FROM trades WHERE `+strings.Join(where, " AND ")+`
		 ORDER BY trades.exit_date DESC, trades.id DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.Trade{}
	for rows.Next() {
		var (
			t       domain.Trade
			buyDate string
			exit    string
			days    *int
		)
		if err := rows.Scan(&t.ID, &t.Sleeve, &t.Symbol, &t.Name, &t.ISIN,
			&t.Qty, &t.BuyPrice, &t.SellPrice, &buyDate, &exit, &days,
			&t.InvestedINR, &t.RealisedINR, &t.Note, &t.Source); err != nil {
			return nil, err
		}
		if buyDate != "" {
			d, err := domain.ParseDate(buyDate)
			if err != nil {
				return nil, err
			}
			t.BuyDate = &d
		}
		if t.ExitDate, err = domain.ParseDate(exit); err != nil {
			return nil, err
		}
		t.HoldingDays = days
		t.ReturnPct = compute.PctOf(t.RealisedINR, t.InvestedINR)
		out = append(out, t)
	}
	return out, rows.Err()
}

// UpsertPriceTargets replaces targets by (sleeve, symbol).
func (s *Store) UpsertPriceTargets(ctx context.Context, targets []domain.PriceTarget) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, t := range targets {
		if _, err := tx.Exec(ctx, `
			INSERT INTO price_targets (sleeve, symbol, isin, target_price, currency, horizon, note, updated_at)
			VALUES ($1, $2, NULLIF($3,''), $4::text::numeric, $5, NULLIF($6,''), NULLIF($7,''), now())
			ON CONFLICT (sleeve, symbol) DO UPDATE
			    SET isin = COALESCE(EXCLUDED.isin, price_targets.isin),
			        target_price = EXCLUDED.target_price,
			        currency = EXCLUDED.currency,
			        horizon = COALESCE(EXCLUDED.horizon, price_targets.horizon),
			        note = COALESCE(EXCLUDED.note, price_targets.note),
			        updated_at = now()`,
			t.Sleeve, t.Symbol, t.ISIN, t.TargetPrice.String(), t.Currency, t.Horizon, t.Note,
		); err != nil {
			return 0, fmt.Errorf("upsert target %s/%s: %w", t.Sleeve, t.Symbol, err)
		}
	}
	return len(targets), tx.Commit(ctx)
}

func (s *Store) PriceTargets(ctx context.Context) ([]domain.PriceTarget, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT sleeve, symbol, COALESCE(isin,''), target_price::text, currency,
		       COALESCE(horizon,''), COALESCE(note,''),
		       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		  FROM price_targets ORDER BY sleeve, symbol`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.PriceTarget{}
	for rows.Next() {
		var t domain.PriceTarget
		if err := rows.Scan(&t.Sleeve, &t.Symbol, &t.ISIN, &t.TargetPrice,
			&t.Currency, &t.Horizon, &t.Note, &t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) DeletePriceTarget(ctx context.Context, sleeve, symbol string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM price_targets WHERE sleeve = $1 AND symbol = $2`, sleeve, symbol)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func dateOrEmpty(d *domain.Date) string {
	if d == nil {
		return ""
	}
	return d.String()
}

// DeleteTrade removes a closed position. Used when something recorded as an
// investment turns out not to be one.
func (s *Store) DeleteTrade(ctx context.Context, id int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM trades WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
