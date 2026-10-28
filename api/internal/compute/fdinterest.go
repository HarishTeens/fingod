package compute

import (
	"fmt"
	"math"
	"math/big"

	"github.com/harishteens/fingod/api/internal/domain"
)

// Compounding modes are declared in domain; aliased here so callers of this
// package do not need both imports.
const (
	CompoundQuarterly = domain.CompoundQuarterly
	CompoundSimple    = domain.CompoundSimple
)

// DaysPerYear is the denominator for elapsed time. Banks vary (365, 366, 360);
// 365 matches what the common online FD calculators use, which is the thing
// this will actually be checked against.
const DaysPerYear = 365.0

// Accrued returns the interest earned by `at`.
//
// Quarterly: P x ((1 + r/4)^(4t) - 1). Simple: P x r x t. In both, t is years
// elapsed since the start date.
//
// This is the one calculation in the package that runs in float64 rather than
// exact rationals: a fractional power is irrational, so there is no exact
// rational answer to compute. float64 carries ~15 significant digits, which on
// a principal of a few lakh is error far below a paisa — but it is why the
// qty-diff engine, where exactness is achievable and load-bearing, does not
// share this code path.
func Accrued(fd domain.FixedDeposit, at domain.Date) (domain.Num, error) {
	principal, err := rat(fd.Principal)
	if err != nil {
		return "", fmt.Errorf("fd %s principal: %w", fd.Bank, err)
	}
	ratePct, err := rat(fd.RatePct)
	if err != nil {
		return "", fmt.Errorf("fd %s rate: %w", fd.Bank, err)
	}

	end := accrualEnd(fd, at)
	days := end.Time.Sub(fd.StartDate.Time).Hours() / 24
	if days <= 0 {
		return "0.00", nil
	}
	years := days / DaysPerYear

	p, _ := principal.Float64()
	r, _ := ratePct.Float64()
	r /= 100

	var interest float64
	switch mode(fd.Compounding) {
	case CompoundSimple:
		interest = p * r * years
	default:
		interest = p * (math.Pow(1+r/4, 4*years) - 1)
	}

	out := new(big.Rat).SetFloat64(interest)
	if out == nil { // NaN or ±Inf, from a nonsense rate or date
		return "", fmt.Errorf("fd %s: interest is not a finite number", fd.Bank)
	}
	return money(out), nil
}

// Value returns principal plus accrued interest at `at`: what the deposit is
// worth on that date. Zero before it starts and once it has been closed, since
// a closed deposit's money has moved somewhere else that is counted already.
func Value(fd domain.FixedDeposit, at domain.Date) (domain.Num, error) {
	if at.Time.Before(fd.StartDate.Time) {
		return "0.00", nil
	}
	if fd.ClosedAt != nil && !at.Time.Before(fd.ClosedAt.Time) {
		return "0.00", nil
	}
	principal, err := rat(fd.Principal)
	if err != nil {
		return "", err
	}
	accrued, err := Accrued(fd, at)
	if err != nil {
		return "", err
	}
	a, err := rat(accrued)
	if err != nil {
		return "", err
	}
	return money(add(principal, a)), nil
}

// accrualEnd stops the clock at whichever comes first: the date asked about,
// maturity, or closure. Interest does not keep accruing on a matured deposit
// that nobody renewed.
func accrualEnd(fd domain.FixedDeposit, at domain.Date) domain.Date {
	end := at
	if !fd.MaturityDate.IsZero() && fd.MaturityDate.Time.Before(end.Time) {
		end = fd.MaturityDate
	}
	if fd.ClosedAt != nil && fd.ClosedAt.Time.Before(end.Time) {
		end = *fd.ClosedAt
	}
	return end
}

func mode(m string) string {
	if m == CompoundSimple {
		return CompoundSimple
	}
	return CompoundQuarterly
}
