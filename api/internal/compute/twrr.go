package compute

import (
	"math"
	"math/big"
	"sort"
	"strconv"

	"github.com/harishteens/fingod/api/internal/domain"
)

// Time-weighted return, which is the only fair way to put a portfolio next to
// an index.
//
// The problem it solves: a SIP of 50k into a fund that did not move still makes
// the position's value climb, and a raw value chart would show that as a line
// going up — indistinguishable from the fund actually earning something. Put
// that line beside the Nifty and the SIP looks like outperformance.
//
// TWRR removes the contribution by breaking the period at every cash flow and
// chaining the sub-period returns:
//
//	r_t   = (V_t - F_t) / V_{t-1} - 1
//	index = 100 * PROD(1 + r_t)
//
// V_t is the position's value at the close of day t and F_t is the net money
// put in that day. Subtracting F_t is the whole trick: it credits the day only
// with what the market did. The result answers "how did a rupee left in here
// from the start behave", which is exactly the question an index answers, and
// deliberately not "what did my money earn" — that is XIRR, a different number
// for a different question.

// Flow is money in or out of a position on one day, in rupees. Positive is
// money in.
type Flow struct {
	Date   domain.Date
	Amount *big.Rat
}

// SeriesPoint is one day of a reconstructed series.
type SeriesPoint struct {
	Date  domain.Date
	Value *big.Rat // position value at close
	Flow  *big.Rat // net money in that day
}

// IndexPoint is one plotted point: the TWRR index and the value behind it.
type IndexPoint struct {
	Date  string     `json:"date"`
	Index domain.Num `json:"index"`
	Value domain.Num `json:"value,omitempty"`
}

// TWRR chains daily returns into an index based at 100.
//
// Days where the position did not exist yet are skipped rather than drawn from
// an invented base: a fund bought in 2024 has no 2022 performance, and a line
// starting at 100 in 2022 would claim it did.
func TWRR(points []SeriesPoint) []IndexPoint {
	sort.Slice(points, func(i, j int) bool {
		return points[i].Date.Time.Before(points[j].Date.Time)
	})

	out := make([]IndexPoint, 0, len(points))
	idx := new(big.Rat).SetInt64(100)
	var prev *big.Rat

	for _, p := range points {
		value := p.Value
		if value == nil {
			value = new(big.Rat)
		}
		flow := p.Flow
		if flow == nil {
			flow = new(big.Rat)
		}

		if prev == nil {
			// The first day the position has any value is the base. Before
			// that there is nothing to index.
			if isZero(value) {
				continue
			}
			prev = value
			out = append(out, IndexPoint{
				Date: p.Date.String(), Index: domain.Num(idx.FloatString(2)), Value: money(value),
			})
			continue
		}

		// A position that went to zero and stayed there has stopped having a
		// return. Carrying the index flat would imply it was held; dropping the
		// point says it was not.
		if isZero(prev) {
			if isZero(value) {
				continue
			}
			prev = value
			continue
		}

		// (V - F) / V_prev. With no flow this is the plain daily return; on a
		// buy day the purchase is removed so only the market shows up.
		gain := sub(value, flow)
		r := new(big.Rat).Quo(gain, prev)
		idx = mul(idx, r)
		prev = value

		out = append(out, IndexPoint{
			Date: p.Date.String(), Index: domain.Num(idx.FloatString(2)), Value: money(value),
		})
	}
	return out
}

// CAGR annualises a total return over a number of days.
//
// Uses float, unlike everything else here, because a fractional power has no
// exact rational answer — the same reason FD compounding does. It is a display
// figure, never an input to another calculation.
func CAGR(startIndex, endIndex domain.Num, days int) domain.Num {
	if days < 30 {
		// Annualising three weeks produces a number like 900% that is
		// arithmetically correct and tells the reader nothing true.
		return ""
	}
	s, e := FloatOf(startIndex), FloatOf(endIndex)
	if s <= 0 || e <= 0 {
		return ""
	}
	years := float64(days) / 365.0
	growth := e / s
	cagr := (math.Pow(growth, 1/years) - 1) * 100
	if math.IsNaN(cagr) || math.IsInf(cagr, 0) {
		return ""
	}
	return domain.Num(strconv.FormatFloat(cagr, 'f', 2, 64))
}

// SeriesSummary is the row beside the chart: what this series did, over what
// window, and how it compares.
type SeriesSummary struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Kind  string `json:"kind"` // portfolio | sleeve | fund | benchmark

	From   string `json:"from"`
	To     string `json:"to"`
	Days   int    `json:"days"`
	Points int    `json:"points"`

	// TWRR over the window, and annualised.
	ReturnPct domain.Num `json:"return_pct"`
	CAGRPct   domain.Num `json:"cagr_pct,omitempty"`

	// Only owned series carry these; a benchmark has no position.
	ValueINR    domain.Num `json:"value_inr,omitempty"`
	InvestedINR domain.Num `json:"invested_inr,omitempty"`

	Series []IndexPoint `json:"series,omitempty"`
}

// SummariseSeries turns an index series into the row that describes it.
// Named for series rather than Summarise, which already belongs to trades.
func SummariseSeries(key, label, kind string, pts []IndexPoint) *SeriesSummary {
	if len(pts) == 0 {
		return nil
	}
	first, last := pts[0], pts[len(pts)-1]
	days := 0
	if f, err := domain.ParseDate(first.Date); err == nil {
		if t, err := domain.ParseDate(last.Date); err == nil {
			days = int(t.Time.Sub(f.Time).Hours() / 24)
		}
	}
	// The index is based at 100, so the return is just how far it has moved.
	ret := sub(mustRat(last.Index.String()), mustRat("100"))
	return &SeriesSummary{
		Key: key, Label: label, Kind: kind,
		From: first.Date, To: last.Date, Days: days, Points: len(pts),
		ReturnPct: domain.Num(ret.FloatString(2)),
		CAGRPct:   CAGR("100", last.Index, days),
		ValueINR:  last.Value,
		Series:    pts,
	}
}
