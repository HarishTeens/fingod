package domain

import "strings"

// Order is one event that changed a quantity, in any asset class.
//
// The tape, as opposed to the three aggregates derived from it — holdings.avg_cost,
// us_cost_basis, trades. Those are answers; this is the working. Reconciling the
// Zerodha tape against live holdings immediately found a stock split, a
// liquid-fund dividend paid in units, and a share that left by an
// unrecorded route. None of the three could have been seen in an aggregate.
type Order struct {
	ID int64 `json:"id,omitempty"`

	// Source and its own id for this event. Zerodha gives a trade_id per fill,
	// and 33 of 268 orders were split across several, so the fill is the grain.
	// Together they are the idempotency key: re-importing an export updates in
	// place rather than doubling a position.
	Source     string `json:"source"`
	ExternalID string `json:"external_id"`

	Sleeve string `json:"sleeve"`
	Symbol string `json:"symbol"`
	ISIN   string `json:"isin,omitempty"`
	Name   string `json:"name,omitempty"`

	Action    string `json:"action"`
	TradeDate Date   `json:"trade_date"`

	// Always positive. Direction is Action's job, so the two cannot disagree.
	Qty      Num    `json:"qty"`
	Price    Num    `json:"price,omitempty"` // per unit in Currency; 0 for non-cash actions
	Currency string `json:"currency,omitempty"`
	FXRate   Num    `json:"fx_rate,omitempty"`
	Fees     Num    `json:"fees,omitempty"`

	OrderID  string `json:"order_id,omitempty"`
	Exchange string `json:"exchange,omitempty"`
	Note     string `json:"note,omitempty"`
	Raw      any    `json:"raw,omitempty"`

	// Computed on read: qty * price * fx_rate.
	GrossINR Num `json:"gross_inr,omitempty"`
}

// Order actions. Buy and sell move money; the middle group moves only quantity
// and leaves cost basis alone; open and close are deposits.
const (
	ActionBuy         = "buy"
	ActionSell        = "sell"
	ActionSplit       = "split"
	ActionBonus       = "bonus"
	ActionAccrual     = "accrual"
	ActionTransferIn  = "transfer_in"
	ActionTransferOut = "transfer_out"
	ActionOpen        = "open"
	ActionClose       = "close"
)

// OrderActions is every legal action, in the order the schema lists them.
var OrderActions = []string{
	ActionBuy, ActionSell,
	ActionSplit, ActionBonus, ActionAccrual, ActionTransferIn, ActionTransferOut,
	ActionOpen, ActionClose,
}

// cashActions move money and therefore need a price. The rest legitimately have
// none: a bonus issue has no cost, and pricing it would invent one.
var cashActions = map[string]bool{ActionBuy: true, ActionSell: true, ActionOpen: true, ActionClose: true}

// OrderSleeves is wider than Sleeves: deposits, EPF and insurance all have a
// history worth keeping even though they are not priced holdings.
var OrderSleeves = append(append([]string{}, TradeSleeves...), SleeveFD, SleeveEPF)

// Sleeve names that exist only outside the holdings table.
const (
	SleeveFD  = "fd"
	SleeveEPF = "epf"
)

type OrderBatch struct {
	Orders []Order `json:"orders"`
	Source string  `json:"source,omitempty"` // default for rows that omit it
}

func (b *OrderBatch) Validate() error {
	if len(b.Orders) == 0 {
		return invalid("orders is empty")
	}
	seen := make(map[string]bool, len(b.Orders))
	for i := range b.Orders {
		o := &b.Orders[i]
		if o.Source == "" {
			o.Source = b.Source
		}
		if strings.TrimSpace(o.Source) == "" {
			return invalid("orders[%d].source is required — it is half the idempotency key", i)
		}
		if strings.TrimSpace(o.ExternalID) == "" {
			return invalid("orders[%d] (%s) needs an external_id — the source's own id for this "+
				"event, which is what stops a re-import doubling the position", i, o.Symbol)
		}
		key := o.Source + "\x00" + o.ExternalID
		if seen[key] {
			return invalid("orders[%d]: %s/%s appears twice in one batch", i, o.Source, o.ExternalID)
		}
		seen[key] = true

		if !contains(OrderSleeves, o.Sleeve) {
			return invalid("orders[%d].sleeve must be one of %s, got %q",
				i, strings.Join(OrderSleeves, ", "), o.Sleeve)
		}
		if strings.TrimSpace(o.Symbol) == "" {
			return invalid("orders[%d].symbol is required", i)
		}
		if !contains(OrderActions, o.Action) {
			return invalid("orders[%d] (%s).action must be one of %s, got %q",
				i, o.Symbol, strings.Join(OrderActions, ", "), o.Action)
		}
		if o.TradeDate.IsZero() {
			return invalid("orders[%d] (%s) needs a trade_date", i, o.Symbol)
		}
		if err := positive(o.Qty, "orders[%d] (%s).qty", i, o.Symbol); err != nil {
			return err
		}
		if strings.HasPrefix(o.Price.String(), "-") {
			return invalid("orders[%d] (%s): price cannot be negative — direction is the "+
				"action's job, not the price's", i, o.Symbol)
		}
		// A buy with no price is almost always a mapping bug rather than a
		// genuinely free share, and it would silently understate cost basis.
		if cashActions[o.Action] && (o.Price.Empty() || isZeroNum(o.Price)) {
			return invalid("orders[%d] (%s): a %s moves money, so it needs a price — use "+
				"bonus, split, accrual or transfer_in for quantity that arrived free",
				i, o.Symbol, o.Action)
		}
		if o.Currency == "" {
			o.Currency = "INR"
		}
		o.Currency = strings.ToUpper(o.Currency)
		if o.FXRate.Empty() {
			o.FXRate = "1"
		}
		if isZeroNum(o.FXRate) || strings.HasPrefix(o.FXRate.String(), "-") {
			return invalid("orders[%d] (%s): fx_rate must be positive, got %q", i, o.Symbol, o.FXRate)
		}
		if o.Currency != "INR" && o.FXRate == "1" {
			return invalid("orders[%d] (%s): currency is %s but fx_rate is 1 — a dollar trade "+
				"converted at one rupee is how a cost basis goes 95x wrong",
				i, o.Symbol, o.Currency)
		}
		if o.Fees.Empty() {
			o.Fees = "0"
		}
		if strings.HasPrefix(o.Fees.String(), "-") {
			return invalid("orders[%d] (%s): fees cannot be negative", i, o.Symbol)
		}
	}
	return nil
}

// OrderPosition is what the tape says a position should be, beside what the
// latest checkpoint actually holds. The gap is the interesting part.
type OrderPosition struct {
	Sleeve     string `json:"sleeve"`
	Symbol     string `json:"symbol"`
	ISIN       string `json:"isin,omitempty"`
	Name       string `json:"name,omitempty"`
	Events     int    `json:"events"`
	FirstTrade *Date  `json:"first_trade,omitempty"`
	LastTrade  *Date  `json:"last_trade,omitempty"`

	NetQty     Num `json:"net_qty"`
	BoughtINR  Num `json:"bought_inr,omitempty"`
	SoldINR    Num `json:"sold_inr,omitempty"`

	// From the checkpoint, when there is a matching holding.
	HeldQty Num `json:"held_qty,omitempty"`
	Diff    Num `json:"diff,omitempty"`

	// Why the two disagree, in words, when they do.
	Status string `json:"status"`
}
