package compute

import (
	"math/big"
	"sort"

	"github.com/harishteens/fingod/api/internal/domain"
)

// NetWorthInput is one checkpoint plus the standing FD rows.
type NetWorthInput struct {
	AsOf          domain.Date
	Holdings      []Position
	Balances      []domain.Balance
	FixedDeposits []domain.FixedDeposit
}

// NetWorth is the two headline figures and everything they were built from.
//
// Two numbers rather than one because they answer different questions. Liquid
// is what could actually be turned into money: it excludes EPF, which cannot be
// touched for decades, and the interest an FD has accrued but not yet paid.
// Total is the full position. Reporting only one would either overstate what is
// reachable or understate what is owned.
type NetWorth struct {
	AsOf domain.Date `json:"as_of_date"`

	// Liquid here is NW_liquid — the net worth definition, not a sleeve. The
	// overnight-rate ETFs that briefly had a sleeve called "liquid" now count
	// as in_equity.
	Liquid domain.Num `json:"liquid"`
	Total  domain.Num `json:"total"`

	Sleeves     map[string]domain.Num `json:"sleeves"`
	Cash        domain.Num            `json:"cash"`
	CreditCard  domain.Num            `json:"credit_card"` // positive = owed, subtracted
	EPF         domain.Num            `json:"epf"`
	Splitwise   domain.Num            `json:"splitwise"`
	FDPrincipal domain.Num            `json:"fd_principal"`
	FDAccrued   domain.Num            `json:"fd_accrued"`
	Investments domain.Num            `json:"investments"` // every sleeve summed
}

// Compute assembles both figures.
//
//	liquid = investments + cash + fd principal - credit card outstanding
//	total  = liquid + epf + fd accrued interest + splitwise receivable
//
// Holding values are recomputed from qty x price x fx rather than read from the
// stored value_inr, so the totals cannot drift from the attribution numbers
// that the qty-diff engine derives from the same three fields.
func Compute(in NetWorthInput) (*NetWorth, error) {
	nw := &NetWorth{AsOf: in.AsOf, Sleeves: map[string]domain.Num{}}

	sleeveSums := map[string]*big.Rat{}
	investments := new(big.Rat)
	for _, h := range in.Holdings {
		q, err := rat(h.Qty)
		if err != nil {
			return nil, err
		}
		p, err := rat(h.Price)
		if err != nil {
			return nil, err
		}
		f, err := rat(h.FXRate.Or("1"))
		if err != nil {
			return nil, err
		}
		v := mul(q, p, f)
		if sleeveSums[h.Sleeve] == nil {
			sleeveSums[h.Sleeve] = new(big.Rat)
		}
		sleeveSums[h.Sleeve].Add(sleeveSums[h.Sleeve], v)
		investments.Add(investments, v)
	}
	for sleeve, sum := range sleeveSums {
		nw.Sleeves[sleeve] = money(sum)
	}

	cash, card, epf, splitwise := new(big.Rat), new(big.Rat), new(big.Rat), new(big.Rat)
	for _, b := range in.Balances {
		v, err := rat(b.AmountINR)
		if err != nil {
			return nil, err
		}
		switch b.Kind {
		case domain.KindCash:
			cash.Add(cash, v)
		case domain.KindCreditCard:
			card.Add(card, v)
		case domain.KindEPF:
			epf.Add(epf, v)
		case domain.KindSplitwise:
			splitwise.Add(splitwise, v)
		}
	}

	// FDs are valued at the checkpoint date from their standing rows, so a
	// deposit entered today is priced correctly at every past checkpoint too.
	principal, accrued := new(big.Rat), new(big.Rat)
	for _, fd := range in.FixedDeposits {
		if in.AsOf.Time.Before(fd.StartDate.Time) {
			continue
		}
		if fd.ClosedAt != nil && !in.AsOf.Time.Before(fd.ClosedAt.Time) {
			continue
		}
		p, err := rat(fd.Principal)
		if err != nil {
			return nil, err
		}
		a, err := Accrued(fd, in.AsOf)
		if err != nil {
			return nil, err
		}
		ar, err := rat(a)
		if err != nil {
			return nil, err
		}
		principal.Add(principal, p)
		accrued.Add(accrued, ar)
	}

	liquid := sub(add(investments, cash, principal), card)
	total := add(liquid, epf, accrued, splitwise)

	nw.Investments = money(investments)
	nw.Cash, nw.CreditCard, nw.EPF, nw.Splitwise = money(cash), money(card), money(epf), money(splitwise)
	nw.FDPrincipal, nw.FDAccrued = money(principal), money(accrued)
	nw.Liquid, nw.Total = money(liquid), money(total)
	return nw, nil
}

// SleeveNames returns the sleeves present, in a stable order, so callers do not
// have to iterate a map to render a table.
func (nw *NetWorth) SleeveNames() []string {
	out := make([]string, 0, len(nw.Sleeves))
	for s := range nw.Sleeves {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}
