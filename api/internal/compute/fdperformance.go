package compute

import (
	"math/big"
	"strings"

	"github.com/harishteens/fingod/api/internal/domain"
)

// SleeveFD is the name fixed deposits go by wherever sleeves are listed. Not a
// real sleeve — there is no holdings row for a deposit — but it is an asset
// class with a target allocation, and leaving it off the investments page
// because of a schema detail would be a lie of omission about a whole sleeve.
const SleeveFD = "fd"

// FixedDepositReturns values every deposit running at `at`, and attributes the
// change since `prev` when one is given.
//
// A deposit has no quantity and no price, so the qty-diff engine cannot touch
// it. Its growth is computed from rate and elapsed time instead, and the
// decomposition still holds, with the terms meaning what they always mean:
//
//	market  interest earned over the period — real return, nobody added it
//	flow    a deposit opened (in) or closed (out) during the period
//	fx      always zero; a rupee deposit has no currency exposure
//
// Same identity as everywhere else: market + flow + fx == the change in value.
func FixedDepositReturns(fds []domain.FixedDeposit, at domain.Date, prev *domain.Date) (*SleeveReturn, error) {
	value, invested := new(big.Rat), new(big.Rat)
	market, flow := new(big.Rat), new(big.Rat)
	rows := []HoldingReturn{}

	for _, fd := range fds {
		v1s, err := Value(fd, at)
		if err != nil {
			return nil, err
		}
		v1, err := rat(v1s)
		if err != nil {
			return nil, err
		}
		principal, err := rat(fd.Principal)
		if err != nil {
			return nil, err
		}

		running := !isZero(v1)
		if running {
			value.Add(value, v1)
			invested.Add(invested, principal)
			accrued := sub(v1, principal)
			rows = append(rows, HoldingReturn{
				Sleeve:   SleeveFD,
				Symbol:   fd.Bank,
				Name:     trimRate(fd.RatePct) + "% · matures " + fd.MaturityDate.Time.Format("2 Jan 2006"),
				Currency: "INR",
				// Price and quantity stay empty on purpose: a deposit has
				// neither, and inventing a quantity of one to fill a column
				// would make it look like something the qty-diff engine can
				// reason about.
				AvgCost: fd.RatePct,
				Return:  returnOf(v1, principal, false),
			})
			_ = accrued
		}

		if prev == nil {
			continue
		}
		v0s, err := Value(fd, *prev)
		if err != nil {
			return nil, err
		}
		v0, err := rat(v0s)
		if err != nil {
			return nil, err
		}

		var m, f *big.Rat
		switch {
		case isZero(v0) && running:
			// Opened during the period: the principal is money in, and anything
			// above it is interest earned since.
			f = principal
			m = sub(v1, principal)
		case !isZero(v0) && !running:
			// Closed during the period. Interest kept accruing to the closing
			// date, then the whole balance left for cash — booking the lot as a
			// loss would be wrong, and booking it as zero would lose the
			// interest.
			endAt := at
			if fd.ClosedAt != nil {
				endAt = *fd.ClosedAt
			} else if fd.MaturityDate.Time.Before(at.Time) {
				endAt = fd.MaturityDate
			}
			atEndS, err := Value(fd, endAt)
			if err != nil {
				return nil, err
			}
			atEnd, err := rat(atEndS)
			if err != nil {
				return nil, err
			}
			if isZero(atEnd) {
				atEnd = add(principal, new(big.Rat))
			}
			m = sub(atEnd, v0)
			f = new(big.Rat).Neg(atEnd)
		default:
			m = sub(v1, v0)
			f = new(big.Rat)
		}
		market.Add(market, m)
		flow.Add(flow, f)

		if running {
			i := len(rows) - 1
			mm, ff, zz := money(m), money(f), domain.Num("0.00")
			dd := money(sub(v1, v0))
			rows[i].Market, rows[i].Flow, rows[i].FX, rows[i].Delta = &mm, &ff, &zz, &dd
		}
	}

	if err := assignShares(rows, value); err != nil {
		return nil, err
	}

	out := &SleeveReturn{
		Sleeve:   SleeveFD,
		Return:   returnOf(value, invested, false),
		Holdings: rows,
	}
	if prev != nil {
		m, f, z := money(market), money(flow), domain.Num("0.00")
		d := money(add(market, flow))
		out.Market, out.Flow, out.FX, out.Delta = &m, &f, &z, &d
	}
	return out, nil
}

// trimRate drops the trailing zeros NUMERIC(7,4) carries, so 6.2500 reads as
// the 6.25 that was typed in.
func trimRate(n domain.Num) string {
	s := n.String()
	if !strings.Contains(s, ".") {
		return s
	}
	s = strings.TrimRight(s, "0")
	return strings.TrimSuffix(s, ".")
}
