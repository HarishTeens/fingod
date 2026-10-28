package store

import (
	"context"
	"math/big"

	"github.com/harishteens/fingod/api/internal/compute"
	"github.com/harishteens/fingod/api/internal/domain"
)

// SeriesKey identifies one comparable line.
type SeriesKey struct {
	Key   string
	Label string
	Kind  string // portfolio | sleeve | fund | benchmark
}

// ReconstructSeries rebuilds daily value and flow for every comparable line,
// from the order tape priced at each day's close.
//
// The tape knows the quantity held on any date back to 2021-11-24 and
// price_history knows what a unit was worth; together they give a value series
// years longer than the two checkpoints that exist. Flows come from the same
// tape, which is what lets the caller compute a time-weighted return rather
// than a line that mistakes a SIP for performance.
//
// One query rather than one per series: the cross of ~1,250 trading days and
// ~64 instruments is small, and doing it per series would re-read the tape
// a dozen times.
func (s *Store) ReconstructSeries(ctx context.Context, from, to string) (
	map[string][]compute.SeriesPoint, []SeriesKey, error) {

	rows, err := s.pool.Query(ctx, `
		WITH bounds AS (
		    SELECT COALESCE(NULLIF($1,'')::date, (SELECT min(trade_date) FROM orders)) AS lo,
		           COALESCE(NULLIF($2,'')::date, (SELECT max(on_date)   FROM price_history)) AS hi
		),
		-- Trading days, taken from the prices themselves. Using a generated
		-- calendar would invent weekends on which nothing closed.
		cal AS (
		    SELECT DISTINCT p.on_date
		      FROM price_history p, bounds b
		     WHERE p.on_date BETWEEN b.lo AND b.hi
		),
		-- Instruments that are actually owned, with the key price_history uses.
		inst AS (
		    SELECT DISTINCT sleeve, symbol,
		           COALESCE(NULLIF(isin,''), symbol) AS instrument
		      FROM orders
		     WHERE sleeve IN ('in_equity','in_mf','us_equity','gold','debt','btc')
		),
		-- Quantity held at the close of each day: every tape event up to and
		-- including that date.
		qty AS (
		    SELECT c.on_date, i.sleeve, i.symbol, i.instrument,
		           sum(CASE o.action
		                 WHEN 'buy'   THEN o.qty  WHEN 'sell'         THEN -o.qty
		                 WHEN 'bonus' THEN o.qty  WHEN 'accrual'      THEN  o.qty
		                 WHEN 'split' THEN o.qty  WHEN 'transfer_in'  THEN  o.qty
		                 WHEN 'open'  THEN o.qty  WHEN 'transfer_out' THEN -o.qty
		                 WHEN 'close' THEN -o.qty END) AS held
		      FROM cal c
		      JOIN inst i ON true
		      JOIN orders o
		        ON o.sleeve = i.sleeve AND o.symbol = i.symbol
		       AND o.trade_date <= c.on_date
		     GROUP BY 1,2,3,4
		    HAVING sum(CASE o.action
		                 WHEN 'buy'   THEN o.qty  WHEN 'sell'         THEN -o.qty
		                 WHEN 'bonus' THEN o.qty  WHEN 'accrual'      THEN  o.qty
		                 WHEN 'split' THEN o.qty  WHEN 'transfer_in'  THEN  o.qty
		                 WHEN 'open'  THEN o.qty  WHEN 'transfer_out' THEN -o.qty
		                 WHEN 'close' THEN -o.qty END) > 0
		),
		-- Value it. An instrument with no close that day is carried at its most
		-- recent one: a fund that did not publish a NAV has not become worthless.
		valued AS (
		    SELECT q.on_date, q.sleeve, q.symbol, q.instrument, q.held,
		           q.held * COALESCE(
		               (SELECT p.close FROM price_history p
		                 WHERE p.instrument = q.instrument AND p.on_date <= q.on_date
		                 ORDER BY p.on_date DESC LIMIT 1), 0) AS value
		      FROM qty q
		),
		-- Money in and out on each day, per instrument, from the same tape.
		flow AS (
		    SELECT o.trade_date AS on_date, o.sleeve, o.symbol,
		           sum(CASE o.action
		                 WHEN 'buy'  THEN  o.gross_inr + o.fees
		                 WHEN 'open' THEN  o.gross_inr + o.fees
		                 WHEN 'sell' THEN -(o.gross_inr - o.fees)
		                 WHEN 'close' THEN -(o.gross_inr - o.fees)
		                 ELSE 0 END) AS amount
		      FROM orders o GROUP BY 1,2,3
		)
		SELECT v.on_date::text, v.sleeve, v.symbol,
		       v.value::text,
		       COALESCE(f.amount, 0)::text
		  FROM valued v
		  LEFT JOIN flow f
		         ON f.on_date = v.on_date AND f.sleeve = v.sleeve AND f.symbol = v.symbol
		 ORDER BY v.on_date`, from, to)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	// Accumulate into every series a row belongs to at once: the instrument
	// itself, its sleeve, and the whole portfolio.
	type acc struct{ value, flow *big.Rat }
	series := map[string]map[string]*acc{} // seriesKey -> date -> totals
	labels := map[string]SeriesKey{}
	order := []string{}

	add := func(key, label, kind, date string, value, flow *big.Rat) {
		if _, ok := labels[key]; !ok {
			labels[key] = SeriesKey{Key: key, Label: label, Kind: kind}
			order = append(order, key)
			series[key] = map[string]*acc{}
		}
		a := series[key][date]
		if a == nil {
			a = &acc{value: new(big.Rat), flow: new(big.Rat)}
			series[key][date] = a
		}
		a.value.Add(a.value, value)
		a.flow.Add(a.flow, flow)
	}

	for rows.Next() {
		var date, sleeve, symbol, valueText, flowText string
		if err := rows.Scan(&date, &sleeve, &symbol, &valueText, &flowText); err != nil {
			return nil, nil, err
		}
		value, ok := new(big.Rat).SetString(valueText)
		if !ok {
			continue
		}
		flow, ok := new(big.Rat).SetString(flowText)
		if !ok {
			flow = new(big.Rat)
		}
		add("portfolio", "Whole portfolio", "portfolio", date, value, flow)
		add(sleeve, sleeveLabel(sleeve), "sleeve", date, value, flow)
		// Individual funds, which is the one place a per-instrument line is
		// asked for by name rather than being noise.
		if sleeve == "in_mf" {
			add("fund:"+symbol, symbol, "fund", date, value, flow)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	out := map[string][]compute.SeriesPoint{}
	for key, byDate := range series {
		pts := make([]compute.SeriesPoint, 0, len(byDate))
		for date, a := range byDate {
			d, err := domain.ParseDate(date)
			if err != nil {
				continue
			}
			pts = append(pts, compute.SeriesPoint{Date: d, Value: a.value, Flow: a.flow})
		}
		out[key] = pts
	}

	keys := make([]SeriesKey, 0, len(order))
	for _, k := range order {
		keys = append(keys, labels[k])
	}
	return out, keys, nil
}

// BenchmarkSeries loads each index as a value series with no flows, which is
// what makes TWRR reduce to the plain price relative for them.
func (s *Store) BenchmarkSeries(ctx context.Context, from, to string) (
	map[string][]compute.SeriesPoint, []SeriesKey, error) {

	rows, err := s.pool.Query(ctx, `
		SELECT b.key, b.label, p.on_date::text, p.close::text
		  FROM benchmarks b
		  JOIN price_history p ON p.instrument = b.key
		 WHERE ($1 = '' OR p.on_date >= $1::date)
		   AND ($2 = '' OR p.on_date <= $2::date)
		 ORDER BY b.sort_order, p.on_date`, from, to)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	out := map[string][]compute.SeriesPoint{}
	var keys []SeriesKey
	seen := map[string]bool{}
	for rows.Next() {
		var key, label, date, closeText string
		if err := rows.Scan(&key, &label, &date, &closeText); err != nil {
			return nil, nil, err
		}
		if !seen[key] {
			seen[key] = true
			keys = append(keys, SeriesKey{Key: key, Label: label, Kind: "benchmark"})
		}
		d, err := domain.ParseDate(date)
		if err != nil {
			continue
		}
		v, ok := new(big.Rat).SetString(closeText)
		if !ok {
			continue
		}
		out[key] = append(out[key], compute.SeriesPoint{Date: d, Value: v})
	}
	return out, keys, rows.Err()
}

// sleeveLabel keeps the server's names in step with the UI's.
func sleeveLabel(s string) string {
	switch s {
	case "in_equity":
		return "IN Equity"
	case "in_mf":
		return "IN Mutual Funds"
	case "us_equity":
		return "US Equity"
	case "gold":
		return "Gold"
	case "debt":
		return "Debt"
	case "btc":
		return "Bitcoin"
	case "fd":
		return "Fixed Deposits"
	}
	return s
}
