package domain

import "strings"

// Trade is a closed position: bought, sold, and the profit is now a fact.
//
// Deliberately not a holding. The qty-diff engine sees a sale as an outflow,
// which is correct and says nothing about whether it was a good one — and once
// the position is gone, cost basis has nothing to compare against either. A
// closed trade is the only place realised profit can live.
type Trade struct {
	ID     int64  `json:"id,omitempty"`
	Sleeve string `json:"sleeve"`
	Symbol string `json:"symbol"`
	Name   string `json:"name,omitempty"`
	ISIN   string `json:"isin,omitempty"`

	// Optional, and genuinely absent in imported rows where the source mixed
	// currencies. Better empty than wrong.
	Qty       Num `json:"qty,omitempty"`
	BuyPrice  Num `json:"buy_price,omitempty"`
	SellPrice Num `json:"sell_price,omitempty"`

	BuyDate     *Date `json:"buy_date,omitempty"`
	ExitDate    Date  `json:"exit_date"`
	HoldingDays *int  `json:"holding_days,omitempty"`

	InvestedINR Num `json:"invested_inr"`
	RealisedINR Num `json:"realised_inr"` // negative is a loss

	Note   string `json:"note,omitempty"`
	Source string `json:"source,omitempty"`

	// Computed on read.
	ReturnPct Num `json:"return_pct,omitempty"`
}

type TradeBatch struct {
	Trades []Trade `json:"trades"`
}

func (b *TradeBatch) Validate() error {
	if len(b.Trades) == 0 {
		return invalid("trades is empty")
	}
	for i := range b.Trades {
		t := &b.Trades[i]
		if !contains(TradeSleeves, t.Sleeve) {
			return invalid("trades[%d].sleeve must be one of %s, got %q", i, strings.Join(TradeSleeves, ", "), t.Sleeve)
		}
		if strings.TrimSpace(t.Symbol) == "" {
			return invalid("trades[%d].symbol is required", i)
		}
		if t.ExitDate.IsZero() {
			return invalid("trades[%d] (%s) needs an exit_date — an open position is a holding, not a trade", i, t.Symbol)
		}
		if t.InvestedINR.Empty() {
			return invalid("trades[%d] (%s) needs invested_inr", i, t.Symbol)
		}
		if strings.HasPrefix(t.InvestedINR.String(), "-") || t.InvestedINR == "0" {
			return invalid("trades[%d] (%s): invested_inr must be positive, got %s", i, t.Symbol, t.InvestedINR)
		}
		if t.RealisedINR.Empty() {
			return invalid("trades[%d] (%s) needs realised_inr — use 0 for a break-even exit, never omit it", i, t.Symbol)
		}
		if t.BuyDate != nil && t.BuyDate.Time.After(t.ExitDate.Time) {
			return invalid("trades[%d] (%s): bought %s but exited %s", i, t.Symbol, t.BuyDate, t.ExitDate)
		}
		if t.Source == "" {
			t.Source = "manual"
		}
	}
	return nil
}

// PriceTarget is the price the owner intends to sell at. A decision, not an
// observation, so it is a standing row rather than part of a checkpoint.
type PriceTarget struct {
	Sleeve      string `json:"sleeve"`
	Symbol      string `json:"symbol"`
	ISIN        string `json:"isin,omitempty"`
	TargetPrice Num    `json:"target_price"`
	Currency    string `json:"currency,omitempty"`
	Horizon     string `json:"horizon,omitempty"`
	Note        string `json:"note,omitempty"`
	UpdatedAt   string `json:"updated_at,omitempty"`
}

type PriceTargetBatch struct {
	Targets []PriceTarget `json:"targets"`
}

func (b *PriceTargetBatch) Validate() error {
	if len(b.Targets) == 0 {
		return invalid("targets is empty")
	}
	for i := range b.Targets {
		t := &b.Targets[i]
		if !contains(Sleeves, t.Sleeve) {
			return invalid("targets[%d].sleeve must be one of %s, got %q", i, strings.Join(Sleeves, ", "), t.Sleeve)
		}
		if strings.TrimSpace(t.Symbol) == "" {
			return invalid("targets[%d].symbol is required", i)
		}
		if t.TargetPrice.Empty() || strings.HasPrefix(t.TargetPrice.String(), "-") || t.TargetPrice == "0" {
			return invalid("targets[%d] (%s) needs a positive target_price", i, t.Symbol)
		}
		if t.Currency == "" {
			// Matched against the holding's own price, which is USD for US
			// equity — a dollar target beside a rupee price reads as 85x away.
			t.Currency = "INR"
			if t.Sleeve == SleeveUSEquity {
				t.Currency = "USD"
			}
		}
		t.Currency = strings.ToUpper(t.Currency)
	}
	return nil
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// Dividend is cash paid out by something still held.
//
// A third kind of realised return, and unlike a trade it does not close the
// position — which is exactly why it cannot be folded into the trade table.
// It comes from Wallet rather than a broker: neither Kite nor INDmoney exposes
// a payout history, but the money lands in a bank account Wallet already tracks.
type Dividend struct {
	Date      Date   `json:"date"`
	AmountINR Num    `json:"amount_inr"`
	Account   string `json:"account,omitempty"`
	Note      string `json:"note,omitempty"`
}
