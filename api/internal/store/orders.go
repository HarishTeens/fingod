package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/harishteens/fingod/api/internal/domain"
)

// UpsertOrders imports tape events idempotently on (source, external_id).
//
// Re-importing an overlapping export must not double a position, and the
// Zerodha exports overlap heavily — 14 files carrying 364 unique trades between
// them, 73 rows appearing more than once.
func (s *Store) UpsertOrders(ctx context.Context, orders []domain.Order) (inserted, updated int, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, o := range orders {
		raw, err := json.Marshal(orEmptyAny(o.Raw))
		if err != nil {
			return 0, 0, err
		}
		var isNew bool
		err = tx.QueryRow(ctx, `
			INSERT INTO orders (source, external_id, sleeve, symbol, isin, name,
			                    action, trade_date, qty, price, currency, fx_rate,
			                    fees, order_id, exchange, note, raw)
			VALUES ($1, $2, $3, $4, NULLIF($5,''), NULLIF($6,''),
			        $7, $8::text::date, $9::text::numeric, $10::text::numeric, $11,
			        $12::text::numeric, $13::text::numeric,
			        NULLIF($14,''), NULLIF($15,''), NULLIF($16,''), $17::text::jsonb)
			ON CONFLICT (source, external_id) DO UPDATE
			    SET sleeve = EXCLUDED.sleeve, symbol = EXCLUDED.symbol,
			        isin = EXCLUDED.isin, name = EXCLUDED.name,
			        action = EXCLUDED.action, trade_date = EXCLUDED.trade_date,
			        qty = EXCLUDED.qty, price = EXCLUDED.price,
			        currency = EXCLUDED.currency, fx_rate = EXCLUDED.fx_rate,
			        fees = EXCLUDED.fees, order_id = EXCLUDED.order_id,
			        exchange = EXCLUDED.exchange, note = EXCLUDED.note,
			        raw = EXCLUDED.raw
			RETURNING (xmax = 0)`,
			o.Source, o.ExternalID, o.Sleeve, o.Symbol, o.ISIN, o.Name,
			o.Action, o.TradeDate.String(), o.Qty.String(), o.Price.Or("0").String(),
			o.Currency, o.FXRate.Or("1").String(), o.Fees.Or("0").String(),
			o.OrderID, o.Exchange, o.Note, string(raw),
		).Scan(&isNew)
		if err != nil {
			return 0, 0, fmt.Errorf("upsert order %s/%s (%s %s): %w",
				o.Source, o.ExternalID, o.Action, o.Symbol, err)
		}
		if isNew {
			inserted++
		} else {
			updated++
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, 0, err
	}
	return inserted, updated, nil
}

const orderColumns = `id, source, external_id, sleeve, symbol, COALESCE(isin,''),
	COALESCE(name,''), action, trade_date::text, qty::text, price::text, currency,
	fx_rate::text, fees::text, gross_inr::text, COALESCE(order_id,''),
	COALESCE(exchange,''), COALESCE(note,'')`

// Orders lists the tape, newest first, optionally narrowed to one sleeve or symbol.
func (s *Store) Orders(ctx context.Context, sleeve, symbol string, limit int) ([]domain.Order, error) {
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+orderColumns+`
		  FROM orders
		 WHERE ($1 = '' OR sleeve = $1)
		   AND ($2 = '' OR symbol = $2)
		 ORDER BY trade_date DESC, id DESC
		 LIMIT $3`, sleeve, symbol, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.Order{}
	for rows.Next() {
		var o domain.Order
		var tradeDate string
		if err := rows.Scan(&o.ID, &o.Source, &o.ExternalID, &o.Sleeve, &o.Symbol,
			&o.ISIN, &o.Name, &o.Action, &tradeDate, &o.Qty, &o.Price, &o.Currency,
			&o.FXRate, &o.Fees, &o.GrossINR, &o.OrderID, &o.Exchange, &o.Note); err != nil {
			return nil, err
		}
		d, err := domain.ParseDate(tradeDate)
		if err != nil {
			return nil, err
		}
		o.TradeDate = d
		out = append(out, o)
	}
	return out, rows.Err()
}

// ReconcileOrders compares what the tape implies against what is actually held.
//
// The whole point of storing the tape. A position where the two agree is
// corroborated from two independent directions; one where they disagree is a
// corporate action, a missing export, or an in-kind payout — and every one of
// those corrupts a cost basis silently if nobody looks.
//
// Matched on ISIN where both sides have one, because tickers get renamed, and
// falling back to symbol otherwise.
func (s *Store) ReconcileOrders(ctx context.Context) ([]domain.OrderPosition, error) {
	// Keyed on a resolved ISIN rather than joining on "ISIN or else symbol":
	// Postgres rejects a FULL JOIN whose condition is an OR, and more usefully,
	// resolving first repairs the six symbols Zerodha exports with a blank ISIN
	// (a handful of symbols). Their ISIN is known from holdings even when
	// every tradebook row omits it, so the two sides still meet.
	rows, err := s.pool.Query(ctx, `
		WITH latest AS (
		    SELECT id FROM checkpoints ORDER BY as_of_date DESC LIMIT 1
		),
		held AS (
		    SELECT h.sleeve, h.symbol, NULLIF(h.isin,'') AS isin, h.qty
		      FROM holdings h JOIN latest l ON l.id = h.checkpoint_id
		),
		resolve AS (
		    SELECT symbol, max(isin) AS isin
		      FROM (SELECT symbol, isin FROM orders WHERE isin IS NOT NULL
		            UNION ALL
		            SELECT symbol, isin FROM held   WHERE isin IS NOT NULL) u
		     GROUP BY symbol
		),
		tape AS (
		    SELECT COALESCE(r.isin, p.sleeve || '/' || p.symbol) AS k, p.*
		      FROM order_positions p LEFT JOIN resolve r ON r.symbol = p.symbol
		     -- Deposits, EPF and insurance keep a history here but are not
		     -- priced holdings, so there is nothing to reconcile them against
		     -- and judging them by an empty holdings table would report every
		     -- one as missing.
		     WHERE p.sleeve IN ('in_equity','in_mf','us_equity','gold','debt','btc')
		),
		live AS (
		    SELECT COALESCE(r.isin, h.sleeve || '/' || h.symbol) AS k, h.*
		      FROM held h LEFT JOIN resolve r ON r.symbol = h.symbol
		)
		SELECT COALESCE(t.sleeve, l.sleeve),
		       COALESCE(t.symbol, l.symbol),
		       COALESCE(t.isin, l.isin, ''),
		       COALESCE(t.name, ''),
		       COALESCE(t.events, 0),
		       COALESCE(t.first_trade::text, ''),
		       COALESCE(t.last_trade::text, ''),
		       COALESCE(t.net_qty, 0)::text,
		       COALESCE(t.bought_inr, 0)::text,
		       COALESCE(t.sold_inr, 0)::text,
		       COALESCE(l.qty, 0)::text,
		       (COALESCE(l.qty, 0) - COALESCE(t.net_qty, 0))::text
		  FROM tape t FULL OUTER JOIN live l ON l.k = t.k
		 -- Both sides zero is a position the tape covers end to end: correct,
		 -- and not worth a row.
		 WHERE COALESCE(l.qty, 0) <> 0 OR COALESCE(t.net_qty, 0) <> 0
		 ORDER BY abs(COALESCE(l.qty, 0) - COALESCE(t.net_qty, 0)) DESC,
		          COALESCE(t.symbol, l.symbol)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.OrderPosition{}
	for rows.Next() {
		var p domain.OrderPosition
		var first, last string
		if err := rows.Scan(&p.Sleeve, &p.Symbol, &p.ISIN, &p.Name, &p.Events,
			&first, &last, &p.NetQty, &p.BoughtINR, &p.SoldINR, &p.HeldQty, &p.Diff); err != nil {
			return nil, err
		}
		if d, err := domain.ParseDate(first); err == nil {
			p.FirstTrade = &d
		}
		if d, err := domain.ParseDate(last); err == nil {
			p.LastTrade = &d
		}
		p.Status = reconcileStatus(p)
		out = append(out, p)
	}
	return out, rows.Err()
}

// reconcileStatus names the disagreement rather than just reporting a number,
// because the number alone does not say whether anything is wrong.
func reconcileStatus(p domain.OrderPosition) string {
	switch {
	case isZeroText(p.Diff):
		return "ok"
	case p.Events == 0:
		return "no orders — held but the tape has never seen it, so it predates the export"
	case isZeroText(p.HeldQty):
		return "not held — the tape says there should be some left"
	default:
		return "mismatch — a corporate action, an in-kind payout, or a gap in the export"
	}
}

func isZeroText(n domain.Num) bool {
	s := n.String()
	if s == "" {
		return true
	}
	for _, c := range s {
		if c != '0' && c != '.' && c != '-' && c != '+' {
			return false
		}
	}
	return true
}
