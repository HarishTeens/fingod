package domain

import "strings"

// USCostBasis is what a US position actually cost, in both currencies.
//
// It exists because INDmoney's own invested_amount cannot answer the question.
// That field back-converts the USD cost at a flat 92.0000 regardless of when
// anything was bought — verified identical to four decimals across every
// holding, while the real ECB rates on those trade dates varied widely.
// Trusting it misstated cost and inflated the reported gain by about half.
//
// So the rupee cost is FIFO'd from the broker order book at the rate that
// applied on each buy date, and stored. Holding CostUSD alongside it is what
// makes the split legible: a rupee return above the dollar return is the
// currency working for you, below it is the currency working against you, and
// without both numbers the two are indistinguishable.
type USCostBasis struct {
	Symbol   string `json:"symbol"`
	Qty      Num    `json:"qty"`
	CostUSD  Num    `json:"cost_usd"`
	CostINR  Num    `json:"cost_inr"`
	FirstBuy *Date  `json:"first_buy,omitempty"`

	// Computed on read: CostINR / CostUSD, the blended rate actually paid.
	BuyRate   Num    `json:"buy_rate,omitempty"`
	Source    string `json:"source,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

// FXRate records the rate used to convert one day's trades, so a cost basis
// stays auditable long after the source export is gone.
type FXRate struct {
	OnDate Date `json:"on_date"`
	USDINR Num  `json:"usd_inr"`

	// The quote date, which precedes OnDate when the trade fell on a weekend
	// or a holiday and there was no quote to use.
	AsOf   *Date  `json:"as_of,omitempty"`
	Source string `json:"source,omitempty"`
}

// USCostBasisBatch replaces the whole open-position set at once.
//
// Replacement rather than upsert: the importer reads the complete order book,
// so it knows the entire open set. A symbol that has been fully sold must
// vanish, and an upsert would leave it behind forever, still claiming a cost
// basis for shares that are gone.
type USCostBasisBatch struct {
	Positions []USCostBasis `json:"positions"`
	FXRates   []FXRate      `json:"fx_rates,omitempty"`
	Source    string        `json:"source,omitempty"`
}

func (b *USCostBasisBatch) Validate() error {
	if b.Source == "" {
		b.Source = "indmoney-orders"
	}
	seen := map[string]bool{}
	for i := range b.Positions {
		p := &b.Positions[i]
		p.Symbol = strings.ToUpper(strings.TrimSpace(p.Symbol))
		if p.Symbol == "" {
			return invalid("positions[%d].symbol is required", i)
		}
		if seen[p.Symbol] {
			return invalid("positions[%d]: %s appears twice — FIFO should have merged the lots", i, p.Symbol)
		}
		seen[p.Symbol] = true
		if err := positive(p.Qty, "positions[%d] (%s).qty", i, p.Symbol); err != nil {
			return err
		}
		// Cost may legitimately be zero (a fully-free grant), but never negative.
		if p.CostUSD.Empty() || strings.HasPrefix(p.CostUSD.String(), "-") {
			return invalid("positions[%d] (%s) needs a non-negative cost_usd", i, p.Symbol)
		}
		if p.CostINR.Empty() || strings.HasPrefix(p.CostINR.String(), "-") {
			return invalid("positions[%d] (%s) needs a non-negative cost_inr", i, p.Symbol)
		}
		if p.Source == "" {
			p.Source = b.Source
		}
	}
	for i := range b.FXRates {
		f := &b.FXRates[i]
		if f.OnDate.IsZero() {
			return invalid("fx_rates[%d].on_date is required", i)
		}
		if err := positive(f.USDINR, "fx_rates[%d] (%s).usd_inr", i, f.OnDate); err != nil {
			return err
		}
		if f.AsOf != nil && f.AsOf.Time.After(f.OnDate.Time) {
			return invalid("fx_rates[%d] (%s): as_of %s is after the trade date — a rate cannot be quoted in the future",
				i, f.OnDate, f.AsOf)
		}
		if f.Source == "" {
			f.Source = b.Source
		}
	}
	return nil
}

func positive(n Num, format string, args ...any) error {
	if n.Empty() || strings.HasPrefix(n.String(), "-") || isZeroNum(n) {
		return invalid(format+" must be positive, got %q", append(args, n.String())...)
	}
	return nil
}

// isZeroNum treats "0", "0.00" and "000.0" alike. Comparing against the literal
// "0" — as the older validators do — passes "0.00" straight through.
func isZeroNum(n Num) bool {
	s := strings.TrimPrefix(strings.TrimPrefix(n.String(), "-"), "+")
	if s == "" {
		return false
	}
	for _, c := range s {
		if c != '0' && c != '.' {
			return false
		}
	}
	return true
}
