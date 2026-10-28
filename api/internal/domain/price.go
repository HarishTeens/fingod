package domain

import "strings"

// Price is one instrument's close on one day.
//
// Kept as text end to end like every other money value here: a NAV that goes
// through a float loses the last digit, and the reconstructed history multiplies
// it by a quantity thousands of times.
type Price struct {
	Instrument string `json:"instrument"`
	OnDate     Date   `json:"on_date"`
	Close      Num    `json:"close"`
	Currency   string `json:"currency,omitempty"`
	Source     string `json:"source,omitempty"`
}

type PriceBatch struct {
	Prices []Price `json:"prices"`
}

func (b *PriceBatch) Validate() error {
	if len(b.Prices) == 0 {
		return invalid("prices is empty")
	}
	seen := make(map[string]bool, len(b.Prices))
	for i := range b.Prices {
		p := &b.Prices[i]
		p.Instrument = strings.TrimSpace(p.Instrument)
		if p.Instrument == "" {
			return invalid("prices[%d].instrument is required — an ISIN, or IDX:<name> for a benchmark", i)
		}
		if p.OnDate.IsZero() {
			return invalid("prices[%d] (%s) needs an on_date", i, p.Instrument)
		}
		key := p.Instrument + "\x00" + p.OnDate.String()
		if seen[key] {
			return invalid("prices[%d]: %s on %s appears twice in one batch", i, p.Instrument, p.OnDate)
		}
		seen[key] = true
		if p.Close.Empty() || strings.HasPrefix(p.Close.String(), "-") {
			return invalid("prices[%d] (%s on %s) needs a non-negative close",
				i, p.Instrument, p.OnDate)
		}
		if p.Currency == "" {
			p.Currency = "INR"
		}
		if p.Source == "" {
			p.Source = "manual"
		}
	}
	return nil
}

// PriceCoverage reports what history exists per instrument.
type PriceCoverage struct {
	Instrument string `json:"instrument"`
	Label      string `json:"label,omitempty"`
	Sleeve     string `json:"sleeve,omitempty"`
	Bars       int    `json:"bars"`
	First      string `json:"first,omitempty"`
	Last       string `json:"last,omitempty"`
}
