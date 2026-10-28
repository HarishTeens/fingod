package compute

import (
	"math/big"
	"sort"

	"github.com/harishteens/fingod/api/internal/domain"
)

// AllocationRow is one line of the rebalance table.
type AllocationRow struct {
	Sleeve    string     `json:"sleeve"`
	Value     domain.Num `json:"value"`
	SharePct  domain.Num `json:"share_pct"`
	TargetPct domain.Num `json:"target_pct"`
	DriftPP   domain.Num `json:"drift_pp"` // share - target, in percentage points
	ToMove    domain.Num `json:"to_move"`  // positive = buy, negative = sell
}

// Allocation is the drift table plus what it was computed against.
type Allocation struct {
	AsOf       domain.Date           `json:"as_of_date"`
	Base       domain.Num            `json:"base"`
	Rows       []AllocationRow       `json:"rows"`
	Untargeted map[string]domain.Num `json:"untargeted,omitempty"`
}

// Allocate builds the drift table from a checkpoint's net worth and the target.
//
// The **target's own keys define the base**. Only positions the target names are
// included, so removing a line from `target_allocation` in settings removes it
// from the denominator too, with no code change. That is the escape hatch for
// EPF: at a 0% target it currently shows as the largest drift in the table and
// tells you to move a large sum out of something you cannot touch for decades.
// Dropping the key entirely is the honest fix, and it is a settings edit.
//
// Anything held but not named is reported in Untargeted rather than silently
// dropped — a sleeve missing from the table should never mean a sleeve missing
// from your net worth.
func Allocate(nw *NetWorth, target map[string]float64) (*Allocation, error) {
	values := map[string]*big.Rat{}
	for sleeve, v := range nw.Sleeves {
		r, err := rat(v)
		if err != nil {
			return nil, err
		}
		values[sleeve] = r
	}

	// FDs enter the table at **principal**, not principal plus accrued.
	//
	// Two reasons, and they agree. It matches the app's own split — NW_liquid
	// counts FD principal and pushes accrued interest into NW_total — so the
	// rebalance table cannot disagree with the headline figures. And accrued
	// interest is not a position you can rebalance: it is not payable until
	// maturity, so an instruction to move it would be an instruction to move
	// money that does not exist yet.
	principal, err := rat(nw.FDPrincipal)
	if err != nil {
		return nil, err
	}
	if !isZero(principal) {
		values["fd"] = principal
	}
	if epf, err := rat(nw.EPF); err != nil {
		return nil, err
	} else if !isZero(epf) {
		values["epf"] = epf
	}

	// Bank balances are offered to the table under "liquid". Whether they
	// actually appear is the target's call, like everything else here: a
	// portfolio that treats cash as a deliberate holding gives it a line, and
	// one that treats it as whatever happens to be left over does not. Card
	// balances are never offered — a debt is not an allocation.
	if cash, err := rat(nw.Cash); err != nil {
		return nil, err
	} else if !isZero(cash) {
		values["liquid"] = cash
	}

	base := new(big.Rat)
	for key := range target {
		if v, ok := values[key]; ok {
			base.Add(base, v)
		}
	}

	out := &Allocation{AsOf: nw.AsOf, Base: money(base)}

	keys := make([]string, 0, len(target))
	for k := range target {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for _, key := range keys {
		value := values[key]
		if value == nil {
			value = new(big.Rat)
		}
		targetPct := new(big.Rat).SetFloat64(target[key])

		row := AllocationRow{
			Sleeve:    key,
			Value:     money(value),
			TargetPct: domain.Num(targetPct.FloatString(2)),
			SharePct:  "0.00",
			DriftPP:   domain.Num(new(big.Rat).Neg(targetPct).FloatString(2)),
			ToMove:    "0.00",
		}
		if !isZero(base) {
			hundred := new(big.Rat).SetInt64(100)
			share := mul(value, hundred)
			share.Quo(share, base)
			want := mul(targetPct, base)
			want.Quo(want, hundred)

			row.SharePct = domain.Num(share.FloatString(2))
			row.DriftPP = domain.Num(sub(share, targetPct).FloatString(2))
			row.ToMove = money(sub(want, value))
		}
		out.Rows = append(out.Rows, row)
	}

	for key, v := range values {
		if _, targeted := target[key]; !targeted && !isZero(v) {
			if out.Untargeted == nil {
				out.Untargeted = map[string]domain.Num{}
			}
			out.Untargeted[key] = money(v)
		}
	}
	return out, nil
}
