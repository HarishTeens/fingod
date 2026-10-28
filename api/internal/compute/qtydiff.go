package compute

import (
	"math/big"
	"sort"

	"github.com/harishteens/fingod/api/internal/domain"
)

// Position is one holding as it stood at one checkpoint.
type Position struct {
	Sleeve   string
	Symbol   string
	Name     string
	ISIN     string
	Qty      domain.Num
	Price    domain.Num // per unit, in the holding's own currency
	FXRate   domain.Num // that currency → INR at this checkpoint; 1 for INR
	Currency string
}

// Attribution splits the change in one holding's rupee value into the three
// things that can cause it.
type Attribution struct {
	Sleeve string `json:"sleeve"`
	Symbol string `json:"symbol"`
	Name   string `json:"name,omitempty"`
	ISIN   string `json:"isin,omitempty"`

	Market domain.Num `json:"market"` // the price moved
	Flow   domain.Num `json:"flow"`   // money went in or came out
	FX     domain.Num `json:"fx"`     // the rupee moved
	Delta  domain.Num `json:"delta"`  // == market + flow + fx, exactly

	ValuePrev domain.Num `json:"value_prev"`
	ValueNow  domain.Num `json:"value_now"`

	QtyPrev domain.Num `json:"qty_prev"`
	QtyNow  domain.Num `json:"qty_now"`

	// New and Exited say which edge case produced this row, so a caller can
	// explain a 100%-flow number instead of just reporting it.
	New    bool `json:"new,omitempty"`
	Exited bool `json:"exited,omitempty"`

	// Flagged marks a flow large enough relative to its sleeve to be worth a
	// human look — most often an unrecorded split or bonus issue.
	Flagged bool `json:"flagged,omitempty"`
}

// Diff attributes the change between two checkpoints, holding by holding.
//
//	market =  qty_p x (price_n - price_p) x fx_n
//	flow   = (qty_n - qty_p) x price_n     x fx_n
//	fx     =  qty_p x  price_p x (fx_n - fx_p)
//
// These sum to value_n - value_p as an algebraic identity, not an
// approximation, which is why the whole package works in exact rationals:
//
//	qₙpₙfₙ - qₚpₚfₚ  ≡  qₚ(pₙ-pₚ)fₙ + (qₙ-qₚ)pₙfₙ + qₚpₚ(fₙ-fₚ)
//
// Holdings are matched on ISIN when both sides carry one, falling back to
// sleeve+symbol. That ordering matters: tickers get renamed after demergers and
// rebrands — and matching on the ticker would read a
// rename as a full exit plus an equal full entry, inventing a large outflow and
// an equal large inflow in the same period.
func Diff(prev, now []Position) ([]Attribution, error) {
	byKey := make(map[string]Position, len(prev))
	for _, p := range prev {
		byKey[matchKey(p)] = p
	}

	out := make([]Attribution, 0, len(now)+len(prev))
	seen := make(map[string]bool, len(now))

	for _, n := range now {
		key := matchKey(n)
		seen[key] = true
		p, existed := byKey[key]
		a, err := attribute(p, n, !existed, false)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}

	// Anything in prev that is not in now was sold or fully redeemed.
	for _, p := range prev {
		if seen[matchKey(p)] {
			continue
		}
		a, err := attribute(p, Position{}, false, true)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Sleeve != out[j].Sleeve {
			return out[i].Sleeve < out[j].Sleeve
		}
		return out[i].Symbol < out[j].Symbol
	})
	return out, nil
}

// matchKey prefers ISIN, the only identifier that survives a ticker rename.
func matchKey(p Position) string {
	if p.ISIN != "" {
		return "isin\x00" + p.ISIN
	}
	return "sym\x00" + p.Sleeve + "\x00" + p.Symbol
}

// exact is the decomposition before any rounding, where the identity holds
// perfectly. Kept separate so the property test can assert equality rather than
// nearness — see decompose.
type exact struct{ market, flow, fx, delta, valuePrev, valueNow *big.Rat }

func attribute(prev, now Position, isNew, exited bool) (Attribution, error) {
	var a Attribution

	// Identity and labels come from whichever side exists; `now` wins so a
	// renamed holding reports under its current ticker.
	src := now
	if exited {
		src = prev
	}
	a.Sleeve, a.Symbol, a.Name, a.ISIN = src.Sleeve, src.Symbol, src.Name, src.ISIN
	a.New, a.Exited = isNew, exited

	e, err := decompose(prev, now, isNew, exited)
	if err != nil {
		return a, err
	}

	// Rounding the three parts independently would let them miss their own
	// total by up to two paise, and a UI that prints "market + flow + fx" beside
	// "delta" would look broken. So the residual is pushed onto the largest
	// component, where it is proportionally invisible.
	market, flow, fx := money(e.market), money(e.flow), money(e.fx)
	delta := money(e.delta)
	market, flow, fx, err = reconcile(market, flow, fx, delta)
	if err != nil {
		return a, err
	}

	a.Market, a.Flow, a.FX, a.Delta = market, flow, fx, delta
	a.ValuePrev, a.ValueNow = money(e.valuePrev), money(e.valueNow)
	a.QtyPrev, a.QtyNow = prev.Qty.Or("0"), now.Qty.Or("0")
	return a, nil
}

// reconcile nudges whichever of the three parts is largest so that they sum to
// the rounded total exactly. The nudge is at most two paise.
func reconcile(market, flow, fx, delta domain.Num) (domain.Num, domain.Num, domain.Num, error) {
	parts := []*domain.Num{&market, &flow, &fx}
	sum := new(big.Rat)
	var largest *domain.Num
	var largestMag *big.Rat
	for _, part := range parts {
		v, err := rat(*part)
		if err != nil {
			return market, flow, fx, err
		}
		sum.Add(sum, v)
		if largestMag == nil || abs(v).Cmp(largestMag) > 0 {
			largest, largestMag = part, abs(v)
		}
	}
	total, err := rat(delta)
	if err != nil {
		return market, flow, fx, err
	}
	residual := sub(total, sum)
	if isZero(residual) {
		return market, flow, fx, nil
	}
	current, err := rat(*largest)
	if err != nil {
		return market, flow, fx, err
	}
	*largest = money(add(current, residual))
	return market, flow, fx, nil
}

func decompose(prev, now Position, isNew, exited bool) (exact, error) {
	var e exact

	qp, err := rat(prev.Qty)
	if err != nil {
		return e, err
	}
	qn, err := rat(now.Qty)
	if err != nil {
		return e, err
	}
	pp, err := rat(prev.Price)
	if err != nil {
		return e, err
	}
	pn, err := rat(now.Price)
	if err != nil {
		return e, err
	}
	fp, err := rat(prev.FXRate)
	if err != nil {
		return e, err
	}
	fn, err := rat(now.FXRate)
	if err != nil {
		return e, err
	}

	switch {
	case isNew:
		// Nothing was held, so there is no previous price to move away from
		// and no previous currency exposure. market and fx vanish on their own
		// (both carry a qty_p factor of zero); the whole change is flow.
		fp = fn
	case exited:
		// The position is gone and nothing came with it — no closing price and
		// no closing rate. Both are carried forward from the last snapshot, so
		// the entire disposal reads as an outflow at its last known valuation.
		//
		// Neither substitution is optional. An implied price of zero would
		// report a total loss that never happened; an implied *rate* of zero
		// would be worse still, booking the whole holding as a currency move —
		// which is exactly what this did before a test caught it.
		//
		// The cost is that a foreign holding sold mid-period has its market and
		// fx components collapsed into flow, since fingod never saw the sale.
		// The identity still holds and net worth is still exact; only the
		// attribution of that one disposal is simplified.
		pn = new(big.Rat).Set(pp)
		fn = new(big.Rat).Set(fp)
	}

	e.market = mul(qp, sub(pn, pp), fn)
	e.flow = mul(sub(qn, qp), pn, fn)
	e.fx = mul(qp, pp, sub(fn, fp))

	e.valuePrev = mul(qp, pp, fp)
	e.valueNow = mul(qn, pn, fn)
	e.delta = sub(e.valueNow, e.valuePrev)
	return e, nil
}

// SleeveAttribution is the same split rolled up to a sleeve.
type SleeveAttribution struct {
	Sleeve    string        `json:"sleeve"`
	Market    domain.Num    `json:"market"`
	Flow      domain.Num    `json:"flow"`
	FX        domain.Num    `json:"fx"`
	Delta     domain.Num    `json:"delta"`
	ValuePrev domain.Num    `json:"value_prev"`
	ValueNow  domain.Num    `json:"value_now"`
	Holdings  []Attribution `json:"holdings"`
}

// BySleeve groups attributions and flags outsized flows.
//
// A single holding whose flow exceeds `flagThreshold` of its sleeve's current
// value is almost always a corporate action that nobody recorded: a split or a
// bonus issue raises quantity with no money in, which the arithmetic can only
// read as an enormous contribution. The flag does not correct it — a
// corporate_actions row does that — it just refuses to let it pass silently.
func BySleeve(attrs []Attribution, flagThreshold domain.Num) ([]SleeveAttribution, error) {
	threshold, err := rat(flagThreshold.Or("0.25"))
	if err != nil {
		return nil, err
	}

	order := []string{}
	groups := map[string]*SleeveAttribution{}
	sums := map[string][6]*big.Rat{} // market, flow, fx, delta, prev, now

	for _, a := range attrs {
		g, ok := groups[a.Sleeve]
		if !ok {
			g = &SleeveAttribution{Sleeve: a.Sleeve}
			groups[a.Sleeve] = g
			order = append(order, a.Sleeve)
			sums[a.Sleeve] = [6]*big.Rat{new(big.Rat), new(big.Rat), new(big.Rat), new(big.Rat), new(big.Rat), new(big.Rat)}
		}
		g.Holdings = append(g.Holdings, a)

		for i, n := range []domain.Num{a.Market, a.Flow, a.FX, a.Delta, a.ValuePrev, a.ValueNow} {
			v, err := rat(n)
			if err != nil {
				return nil, err
			}
			sums[a.Sleeve][i].Add(sums[a.Sleeve][i], v)
		}
	}

	sort.Strings(order)
	out := make([]SleeveAttribution, 0, len(order))
	for _, sleeve := range order {
		g, s := groups[sleeve], sums[sleeve]
		g.Market, g.Flow, g.FX, g.Delta = money(s[0]), money(s[1]), money(s[2]), money(s[3])
		g.ValuePrev, g.ValueNow = money(s[4]), money(s[5])

		limit := mul(threshold, abs(s[5]))
		if !isZero(limit) {
			for i := range g.Holdings {
				flow, err := rat(g.Holdings[i].Flow)
				if err != nil {
					return nil, err
				}
				g.Holdings[i].Flagged = abs(flow).Cmp(limit) > 0
			}
		}
		out = append(out, *g)
	}
	return out, nil
}
