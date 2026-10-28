package compute

import (
	"math/big"
	"sort"

	"github.com/harishteens/fingod/api/internal/domain"
)

// ProjectionRow is one holding valued at its price target instead of its price.
type ProjectionRow struct {
	Sleeve   string     `json:"sleeve"`
	Symbol   string     `json:"symbol"`
	Name     string     `json:"name,omitempty"`
	Qty      domain.Num `json:"qty"`
	Invested domain.Num `json:"invested"`
	Value    domain.Num `json:"value"`
	Target   domain.Num `json:"target_price"`
	AtTarget domain.Num `json:"value_at_target"`
	Gain     domain.Num `json:"gain"`     // against cost, if the target is reached
	GainPct  domain.Num `json:"gain_pct"` // that gain over cost
	ToCome   domain.Num `json:"to_come"`  // from today's price, not from cost
	AwayPct  domain.Num `json:"away_pct"` // how far the price still has to move
	Horizon  string     `json:"horizon,omitempty"`
}

// Projection is the whole "if every target is reached" scenario.
//
// Emphatically not a forecast. It is arithmetic on numbers the owner chose, and
// its only claim is internal consistency: this is what the positions would be
// worth at the prices he wrote down. Untargeted holdings are excluded rather
// than valued at today's price, because mixing the two would quietly dilute the
// percentage with positions the scenario says nothing about.
type Projection struct {
	Rows       []ProjectionRow `json:"rows"`
	Invested   domain.Num      `json:"invested"`
	Value      domain.Num      `json:"value"`
	AtTarget   domain.Num      `json:"value_at_target"`
	Gain       domain.Num      `json:"gain"`
	GainPct    domain.Num      `json:"gain_pct"`
	Realised   domain.Num      `json:"realised_so_far"`
	ToCome     domain.Num      `json:"to_come"`
	ToComePct  domain.Num      `json:"to_come_pct"`
	Untargeted []string        `json:"untargeted,omitempty"`
}

// Project values every targeted holding at its target.
func Project(sleeves []SleeveReturn) (*Projection, error) {
	out := &Projection{Rows: []ProjectionRow{}}
	invested, value, atTarget := new(big.Rat), new(big.Rat), new(big.Rat)
	hundred := new(big.Rat).SetInt64(100)

	for _, s := range sleeves {
		for _, h := range s.Holdings {
			if h.TargetPrice.Empty() || h.Qty.Empty() {
				if !h.Qty.Empty() {
					out.Untargeted = append(out.Untargeted, h.Symbol)
				}
				continue
			}
			qty, err := rat(h.Qty)
			if err != nil {
				return nil, err
			}
			target, err := rat(h.TargetPrice)
			if err != nil {
				return nil, err
			}
			inv, err := rat(h.Invested)
			if err != nil {
				return nil, err
			}
			val, err := rat(h.Value)
			if err != nil {
				return nil, err
			}

			// Targets are quoted in the holding's own currency, so a US target
			// has to be converted before it can join a rupee total. Today's
			// rate is the honest choice: the scenario is about price, and
			// pretending to know the rate on an unknown future date would add
			// a second guess to a first.
			fx := new(big.Rat).SetInt64(1)
			if !isZero(qty) && !isZero(val) {
				price, err := rat(h.Price)
				if err != nil {
					return nil, err
				}
				if !isZero(price) {
					fx = new(big.Rat).Quo(val, mul(qty, price))
				}
			}
			at := mul(qty, target, fx)

			row := ProjectionRow{
				Sleeve: h.Sleeve, Symbol: h.Symbol, Name: h.Name, Qty: h.Qty,
				Invested: money(inv), Value: money(val), Target: h.TargetPrice,
				AtTarget: money(at), Gain: money(sub(at, inv)),
				ToCome: money(sub(at, val)), AwayPct: h.TargetAway, Horizon: h.TargetHorizon,
			}
			if !isZero(inv) {
				g := mul(sub(at, inv), hundred)
				g.Quo(g, inv)
				row.GainPct = domain.Num(g.FloatString(2))
			}
			out.Rows = append(out.Rows, row)

			invested.Add(invested, inv)
			value.Add(value, val)
			atTarget.Add(atTarget, at)
		}
	}

	sort.Slice(out.Rows, func(i, j int) bool {
		return FloatOf(out.Rows[i].Gain) > FloatOf(out.Rows[j].Gain)
	})
	sort.Strings(out.Untargeted)

	out.Invested, out.Value, out.AtTarget = money(invested), money(value), money(atTarget)
	out.Gain = money(sub(atTarget, invested))
	out.ToCome = money(sub(atTarget, value))
	if !isZero(invested) {
		g := mul(sub(atTarget, invested), hundred)
		g.Quo(g, invested)
		out.GainPct = domain.Num(g.FloatString(2))
	}
	if !isZero(value) {
		t := mul(sub(atTarget, value), hundred)
		t.Quo(t, value)
		out.ToComePct = domain.Num(t.FloatString(2))
	}
	return out, nil
}
