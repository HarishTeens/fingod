package compute

import (
	"math/big"
	"sort"

	"github.com/harishteens/fingod/api/internal/domain"
)

// dustQty is the quantity change below which a difference is treated as a
// source rounding its own output rather than as anything having happened.
// INDmoney varies its decimal places between calls — 2.01291325 one week,
// 2.0129132 the next — and without this every US holding reports a phantom
// disposal of 5e-08 every week, which trains the eye to skip the list.
var dustQty = mustRat("0.000001")

// Disposal is a holding that shrank or vanished between two checkpoints —
// a sale, detected rather than remembered.
//
// This is the answer to "use the sources, not a journal". Neither Kite nor
// INDmoney will tell you what you sold: Kite's trade endpoints cover today
// only, and INDmoney has no transactions API at all. But a position that was
// there last week and is smaller this week is a sale, and the checkpoints
// already know it. The one thing they cannot know is the price it went out at,
// because the snapshot only ever sees what is still held.
type Disposal struct {
	Sleeve string `json:"sleeve"`
	Symbol string `json:"symbol"`
	Name   string `json:"name,omitempty"`
	ISIN   string `json:"isin,omitempty"`

	QtyBefore domain.Num `json:"qty_before"`
	QtyAfter  domain.Num `json:"qty_after"`
	QtySold   domain.Num `json:"qty_sold"`
	FullExit  bool       `json:"full_exit"`

	AvgCost      domain.Num `json:"avg_cost,omitempty"`
	InvestedSold domain.Num `json:"invested_sold,omitempty"`

	// LastPrice is what it was worth at the earlier checkpoint — the best
	// available guess at the sale price, and explicitly a guess. A week of
	// movement sits between it and the truth, which is why the refresh asks
	// rather than assumes.
	LastPrice         domain.Num `json:"last_price"`
	Currency          string     `json:"currency"`
	FXRate            domain.Num `json:"fx_rate"`
	EstimatedProceeds domain.Num `json:"estimated_proceeds"`
	EstimatedRealised domain.Num `json:"estimated_realised,omitempty"`

	Between [2]string `json:"between"`
}

// FindDisposals diffs two checkpoints and reports what left.
//
// Matched on ISIN first, exactly as the qty-diff engine does: a ticker rename
// would otherwise look like a total sale and an unrelated purchase, and would
// invent a realised loss for the entire position.
func FindDisposals(prev, now []domain.Holding, prevDate, nowDate string) ([]Disposal, error) {
	after := map[string]domain.Holding{}
	for _, h := range now {
		after[attrKey(h.Sleeve, h.Symbol, h.ISIN)] = h
	}

	out := []Disposal{}
	for _, before := range prev {
		key := attrKey(before.Sleeve, before.Symbol, before.ISIN)
		qtyBefore, err := rat(before.Qty)
		if err != nil {
			return nil, err
		}

		current, held := after[key]
		qtyAfter := new(big.Rat)
		if held {
			if qtyAfter, err = rat(current.Qty); err != nil {
				return nil, err
			}
		}
		if qtyAfter.Cmp(qtyBefore) >= 0 {
			continue // unchanged, or bought more — not a disposal
		}

		sold := sub(qtyBefore, qtyAfter)
		// Ignore dust. INDmoney varies how many decimals it returns between
		// calls — 2.01291325 one week, 2.0129132 the next — which is a change
		// of 5e-08 and reads as five disposals nobody made. A real sale of a
		// fractional US share is still orders of magnitude above this, and a
		// weekly list of phantom exits would train the eye to skip the list.
		if sold.Cmp(dustQty) < 0 {
			continue
		}
		price, err := rat(before.Price)
		if err != nil {
			return nil, err
		}
		fx, err := rat(before.FXRate.Or("1"))
		if err != nil {
			return nil, err
		}

		d := Disposal{
			Sleeve: before.Sleeve, Symbol: before.Symbol, Name: before.Name, ISIN: before.ISIN,
			QtyBefore: before.Qty, QtyAfter: current.Qty.Or("0"),
			QtySold:  domain.Num(sold.FloatString(10)),
			FullExit: isZero(qtyAfter),
			AvgCost:  before.AvgCost, LastPrice: before.Price,
			Currency: before.Currency, FXRate: before.FXRate.Or("1"),
			Between: [2]string{prevDate, nowDate},
		}
		d.EstimatedProceeds = money(mul(sold, price, fx))

		// Cost of the shares that left, at the average price paid for the
		// position — the same basis every broker uses for a partial exit.
		if !before.InvestedINR.Empty() && !isZero(qtyBefore) {
			investedTotal, err := rat(before.InvestedINR)
			if err != nil {
				return nil, err
			}
			portion := mul(investedTotal, sold)
			portion.Quo(portion, qtyBefore)
			d.InvestedSold = money(portion)
			d.EstimatedRealised = money(sub(mul(sold, price, fx), portion))
		}
		out = append(out, d)
	}

	sort.Slice(out, func(i, j int) bool {
		return FloatOf(out[i].EstimatedProceeds) > FloatOf(out[j].EstimatedProceeds)
	})
	return out, nil
}
