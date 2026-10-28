// Package compute holds the arithmetic the rest of fingod reports: the
// qty-diff attribution, the two net worth figures, and FD interest.
//
// Everything except FD compounding is done in exact rationals (math/big.Rat)
// rather than float64. That is not fastidiousness — the qty-diff decomposition
// is an algebraic identity, `market + flow + fx == Δvalue`, and in floats it
// holds only to a tolerance that grows with the numbers. In rationals it holds
// exactly, so the property test can assert equality rather than nearness, and
// a residual is then always a real bug rather than accumulated noise.
package compute

import (
	"fmt"
	"math/big"

	"github.com/harishteens/fingod/api/internal/domain"
)

// rat parses a decimal literal into an exact rational.
func rat(n domain.Num) (*big.Rat, error) {
	if n.Empty() {
		return new(big.Rat), nil
	}
	r, ok := new(big.Rat).SetString(n.String())
	if !ok {
		return nil, fmt.Errorf("%q is not a decimal number", n)
	}
	return r, nil
}

// ratMul parses two decimals and multiplies them exactly.
//
// Used for a foreign holding's own-currency value, which is qty * price with
// no rate applied — holdings_value_consistent already guarantees that equals
// value_inr / fx_rate, so there is no separate column to read it from.
func ratMul(a, b domain.Num) (*big.Rat, error) {
	x, err := rat(a)
	if err != nil {
		return nil, err
	}
	y, err := rat(b)
	if err != nil {
		return nil, err
	}
	return mul(x, y), nil
}

// mustRat is for literals in tests and for values already validated on the way
// into the database.
func mustRat(s string) *big.Rat {
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		panic("compute: bad decimal literal " + s)
	}
	return r
}

// money renders a rational as rupees and paise.
//
// big.Rat.FloatString rounds half away from zero, which is what Postgres
// `round(numeric, 2)` does, so a figure computed here and the same figure
// computed in SQL agree to the paisa instead of differing on the ties.
func money(r *big.Rat) domain.Num { return domain.Num(r.FloatString(2)) }

func add(rs ...*big.Rat) *big.Rat {
	sum := new(big.Rat)
	for _, r := range rs {
		sum.Add(sum, r)
	}
	return sum
}

func sub(a, b *big.Rat) *big.Rat { return new(big.Rat).Sub(a, b) }

func mul(rs ...*big.Rat) *big.Rat {
	product := new(big.Rat).SetInt64(1)
	for _, r := range rs {
		product.Mul(product, r)
	}
	return product
}

func isZero(r *big.Rat) bool { return r.Sign() == 0 }

func abs(r *big.Rat) *big.Rat { return new(big.Rat).Abs(r) }

// AddMoney sums two decimal literals exactly and renders the result to paise.
// Exported so the HTTP layer can total a list without importing math/big or
// reaching for a float.
func AddMoney(a string, b domain.Num) string {
	left, ok := new(big.Rat).SetString(a)
	if !ok {
		return a
	}
	right, err := rat(b)
	if err != nil {
		return a
	}
	return money(add(left, right)).String()
}

// AddMoneyStrings sums two decimal literals exactly, treating "" as zero.
func AddMoneyStrings(a, b domain.Num) domain.Num {
	left, err := rat(a)
	if err != nil {
		return b
	}
	right, err := rat(b)
	if err != nil {
		return a
	}
	return money(add(left, right))
}

// FloatOf parses a decimal literal for ranking only — never for a figure that
// is displayed or stored.
func FloatOf(n domain.Num) float64 {
	r, err := rat(n)
	if err != nil {
		return 0
	}
	f, _ := r.Float64()
	return f
}

// SubMoneyStrings subtracts b from a exactly, rendering to paise.
func SubMoneyStrings(a, b domain.Num) domain.Num {
	left, err := rat(a)
	if err != nil {
		return a
	}
	right, err := rat(b)
	if err != nil {
		return a
	}
	return money(sub(left, right))
}

// PctOf renders part/whole as a percentage to two places.
func PctOf(part, whole domain.Num) domain.Num {
	p, err := rat(part)
	if err != nil {
		return ""
	}
	w, err := rat(whole)
	if err != nil || isZero(w) {
		return ""
	}
	out := mul(p, new(big.Rat).SetInt64(100))
	out.Quo(out, w)
	return domain.Num(out.FloatString(2))
}
