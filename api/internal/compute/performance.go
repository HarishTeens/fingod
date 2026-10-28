package compute

import (
	"math/big"
	"sort"

	"github.com/harishteens/fingod/api/internal/domain"
)

// Return is what a position has done since it was bought — the question a
// single checkpoint can answer.
//
// Deliberately separate from the qty-diff attribution, which answers a
// different one: what happened *between* two checkpoints, and how much of it
// was the market rather than money added. Since-inception return needs cost
// basis and one snapshot; period attribution needs two snapshots and no cost
// basis. Neither substitutes for the other, and conflating them is how a
// dashboard ends up claiming a SIP was a gain.
type Return struct {
	Value      domain.Num `json:"value"`
	Invested   domain.Num `json:"invested"`
	Unrealised domain.Num `json:"unrealised"`
	ReturnPct  domain.Num `json:"return_pct,omitempty"`
	// Partial is set when some holdings in the group had no cost basis, so the
	// invested figure covers only part of the value and the percentage would
	// flatter. A number that is quietly incomplete is worse than one labelled.
	Partial bool `json:"partial,omitempty"`
}

func returnOf(value, invested *big.Rat, partial bool) Return {
	r := Return{
		Value:      money(value),
		Invested:   money(invested),
		Unrealised: money(sub(value, invested)),
		Partial:    partial,
	}
	if !isZero(invested) {
		pct := mul(sub(value, invested), new(big.Rat).SetInt64(100))
		pct.Quo(pct, invested)
		r.ReturnPct = domain.Num(pct.FloatString(2))
	}
	return r
}

// ForeignReturn is the same position measured in the currency it actually
// trades in, present only for holdings that are not rupee-denominated.
//
// It exists so the rupee return can be read. A US holding up 31% in rupees and
// 27% in dollars earned four points from the currency and the rest from the
// company, and those are different facts about different risks — one is a bet
// on Microsoft, the other an unhedged short-rupee position carried alongside
// it. Reporting only the rupee figure hides the second entirely, which is how
// a flat-rate cost conversion went unnoticed long enough to inflate this
// sleeve from 4.99% to 7.70%.
//
// BuyRate against LiveRate reads the direction directly: BuyRate below
// LiveRate means the rupee has weakened since purchase and is adding to the
// rupee return, above means it has firmed and is subtracting.
type ForeignReturn struct {
	Currency   string     `json:"currency"`
	Value      domain.Num `json:"value"`
	Invested   domain.Num `json:"invested"`
	Unrealised domain.Num `json:"unrealised"`
	ReturnPct  domain.Num `json:"return_pct,omitempty"`
	BuyRate    domain.Num `json:"buy_rate,omitempty"`
	LiveRate   domain.Num `json:"live_rate,omitempty"`
	Partial    bool       `json:"partial,omitempty"`
}

func foreignReturn(currency string, value, invested *big.Rat, live *big.Rat, partial bool) *ForeignReturn {
	f := &ForeignReturn{
		Currency:   currency,
		Value:      money(value),
		Invested:   money(invested),
		Unrealised: money(sub(value, invested)),
		Partial:    partial,
	}
	if !isZero(invested) {
		pct := mul(sub(value, invested), new(big.Rat).SetInt64(100))
		pct.Quo(pct, invested)
		f.ReturnPct = domain.Num(pct.FloatString(2))
	}
	if live != nil && !isZero(live) {
		f.LiveRate = domain.Num(live.FloatString(4))
	}
	return f
}

// HoldingReturn is one row of a sleeve's detail table.
type HoldingReturn struct {
	Sleeve   string     `json:"sleeve"`
	Symbol   string     `json:"symbol"`
	Name     string     `json:"name,omitempty"`
	ISIN     string     `json:"isin,omitempty"`
	Qty      domain.Num `json:"qty"`
	Price    domain.Num `json:"price"`
	AvgCost  domain.Num `json:"avg_cost,omitempty"`
	Currency string     `json:"currency"`

	// SharePct is this holding's share of its own sleeve, not of the whole
	// portfolio — the question in front of a sleeve's table is always "how
	// concentrated is this sleeve", and a share of net worth would put every
	// row near zero.
	SharePct domain.Num `json:"share_pct,omitempty"`

	// The price this is meant to be sold at, and how far off it is. The owner
	// sells on target, so this is the column that says what to act on.
	TargetPrice   domain.Num `json:"target_price,omitempty"`
	TargetAway    domain.Num `json:"target_away_pct,omitempty"`
	TargetHit     bool       `json:"target_hit,omitempty"`
	TargetHorizon string     `json:"target_horizon,omitempty"`

	Return

	// Foreign is the same row in its trading currency, for non-INR holdings.
	Foreign *ForeignReturn `json:"foreign,omitempty"`

	// Attribution against the previous checkpoint, absent until there is one.
	Market *domain.Num `json:"market,omitempty"`
	Flow   *domain.Num `json:"flow,omitempty"`
	FX     *domain.Num `json:"fx,omitempty"`
	Delta  *domain.Num `json:"delta,omitempty"`
	Flag   bool        `json:"flagged,omitempty"`
}

// SleeveReturn aggregates a sleeve.
type SleeveReturn struct {
	Sleeve string `json:"sleeve"`
	Return

	// Foreign aggregates the sleeve in its trading currency when every holding
	// in it shares one. Mixed-currency sleeves get nothing rather than a sum of
	// unlike units.
	Foreign *ForeignReturn `json:"foreign,omitempty"`

	Market *domain.Num `json:"market,omitempty"`
	Flow   *domain.Num `json:"flow,omitempty"`
	FX     *domain.Num `json:"fx,omitempty"`
	Delta  *domain.Num `json:"delta,omitempty"`

	Holdings []HoldingReturn `json:"holdings,omitempty"`
}

// Returns computes per-holding and per-sleeve return for one checkpoint, and
// attaches attribution when a comparison checkpoint is supplied.
func Returns(now []domain.Holding, prev []domain.Holding, flagThreshold domain.Num) ([]SleeveReturn, *Return, error) {
	var attribution map[string]Attribution
	var sleeveAttr map[string]SleeveAttribution
	if prev != nil {
		attrs, err := Diff(positions(prev), positions(now))
		if err != nil {
			return nil, nil, err
		}
		grouped, err := BySleeve(attrs, flagThreshold)
		if err != nil {
			return nil, nil, err
		}
		attribution = map[string]Attribution{}
		sleeveAttr = map[string]SleeveAttribution{}
		for _, g := range grouped {
			sleeveAttr[g.Sleeve] = g
			for _, h := range g.Holdings {
				attribution[attrKey(h.Sleeve, h.Symbol, h.ISIN)] = h
			}
		}
	}

	type acc struct {
		value, invested *big.Rat
		partial         bool
		rows            []HoldingReturn

		// Foreign totals, plus the currency they are in. currency is set to
		// "" the moment a second one appears, which is what suppresses a
		// nonsense sum across unlike units.
		fxValue, fxInvested *big.Rat
		fxCurrency          string
		fxPartial, fxMixed  bool
		liveRate            *big.Rat
	}
	bySleeve := map[string]*acc{}
	totalValue, totalInvested := new(big.Rat), new(big.Rat)
	totalPartial := false

	for _, h := range now {
		value, err := rat(h.ValueINR)
		if err != nil {
			return nil, nil, err
		}
		invested, err := rat(h.InvestedINR)
		if err != nil {
			return nil, nil, err
		}
		missing := h.InvestedINR.Empty()

		a := bySleeve[h.Sleeve]
		if a == nil {
			a = &acc{value: new(big.Rat), invested: new(big.Rat)}
			bySleeve[h.Sleeve] = a
		}
		a.value.Add(a.value, value)
		a.invested.Add(a.invested, invested)
		a.partial = a.partial || missing
		totalValue.Add(totalValue, value)
		totalInvested.Add(totalInvested, invested)
		totalPartial = totalPartial || missing

		row := HoldingReturn{
			Sleeve: h.Sleeve, Symbol: h.Symbol, Name: h.Name, ISIN: h.ISIN,
			Qty: h.Qty, Price: h.Price, AvgCost: h.AvgCost, Currency: h.Currency,
			Return: returnOf(value, invested, missing),
		}

		// The same row in its own currency. Only for genuinely foreign
		// holdings: an INR position would just restate the rupee figures.
		if h.Currency != "" && h.Currency != "INR" {
			fxValue, err := ratMul(h.Qty, h.Price)
			if err != nil {
				return nil, nil, err
			}
			fxInvested, err := rat(h.InvestedUSD)
			if err != nil {
				return nil, nil, err
			}
			live, err := rat(h.FXRate)
			if err != nil {
				return nil, nil, err
			}
			fxMissing := h.InvestedUSD.Empty()
			row.Foreign = foreignReturn(h.Currency, fxValue, fxInvested, live, fxMissing)
			// The rate actually paid, derived rather than stored: rupee cost
			// over dollar cost is the blend across every lot, whatever the
			// dates were.
			if !isZero(fxInvested) && !missing {
				br := new(big.Rat).Quo(invested, fxInvested)
				row.Foreign.BuyRate = domain.Num(br.FloatString(4))
			}

			if a.fxValue == nil {
				a.fxValue, a.fxInvested = new(big.Rat), new(big.Rat)
				a.fxCurrency = h.Currency
			} else if a.fxCurrency != h.Currency {
				a.fxMixed = true
			}
			a.fxValue.Add(a.fxValue, fxValue)
			a.fxInvested.Add(a.fxInvested, fxInvested)
			a.fxPartial = a.fxPartial || fxMissing
			a.liveRate = live
		}

		if at, ok := attribution[attrKey(h.Sleeve, h.Symbol, h.ISIN)]; ok {
			row.Market, row.Flow, row.FX, row.Delta = &at.Market, &at.Flow, &at.FX, &at.Delta
			row.Flag = at.Flagged
		}
		a.rows = append(a.rows, row)
	}

	names := make([]string, 0, len(bySleeve))
	for s := range bySleeve {
		names = append(names, s)
	}
	sort.Slice(names, func(i, j int) bool {
		return bySleeve[names[i]].value.Cmp(bySleeve[names[j]].value) > 0
	})

	out := make([]SleeveReturn, 0, len(names))
	for _, name := range names {
		a := bySleeve[name]
		sort.Slice(a.rows, func(i, j int) bool {
			return FloatOf(a.rows[i].Value) > FloatOf(a.rows[j].Value)
		})
		if err := assignShares(a.rows, a.value); err != nil {
			return nil, nil, err
		}
		sr := SleeveReturn{Sleeve: name, Return: returnOf(a.value, a.invested, a.partial), Holdings: a.rows}
		if a.fxValue != nil && !a.fxMixed {
			sr.Foreign = foreignReturn(a.fxCurrency, a.fxValue, a.fxInvested, a.liveRate, a.fxPartial)
			// Suppressed when any holding lacks a foreign basis: a blended rate
			// over a partial denominator is not the rate anything was bought at.
			if !isZero(a.fxInvested) && !a.partial && !a.fxPartial {
				br := new(big.Rat).Quo(a.invested, a.fxInvested)
				sr.Foreign.BuyRate = domain.Num(br.FloatString(4))
			}
		}
		if g, ok := sleeveAttr[name]; ok {
			sr.Market, sr.Flow, sr.FX, sr.Delta = &g.Market, &g.Flow, &g.FX, &g.Delta
		}
		out = append(out, sr)
	}
	total := returnOf(totalValue, totalInvested, totalPartial)
	return out, &total, nil
}

// attrKey matches Diff's own preference for ISIN over ticker.
func attrKey(sleeve, symbol, isin string) string {
	if isin != "" {
		return "isin\x00" + isin
	}
	return "sym\x00" + sleeve + "\x00" + symbol
}

func positions(hs []domain.Holding) []Position {
	out := make([]Position, 0, len(hs))
	for _, h := range hs {
		out = append(out, Position{
			Sleeve: h.Sleeve, Symbol: h.Symbol, Name: h.Name, ISIN: h.ISIN,
			Qty: h.Qty, Price: h.Price, FXRate: h.FXRate, Currency: h.Currency,
		})
	}
	return out
}

// assignShares fills SharePct so the column sums to exactly 100.
//
// Computed from the exact rationals rather than the rounded row values, then
// the rounding residue — a few hundredths across thirty rows — is pushed onto
// the largest share, where it is invisible. Percentages that visibly total
// 100.03 invite someone to go looking for the missing holding.
func assignShares(rows []HoldingReturn, total *big.Rat) error {
	if isZero(total) || len(rows) == 0 {
		return nil
	}
	hundred := new(big.Rat).SetInt64(100)
	sum := new(big.Rat)
	largest, largestVal := -1, new(big.Rat)

	for i := range rows {
		v, err := rat(rows[i].Value)
		if err != nil {
			return err
		}
		share := mul(v, hundred)
		share.Quo(share, total)
		rounded := domain.Num(share.FloatString(2))
		rows[i].SharePct = rounded

		r, err := rat(rounded)
		if err != nil {
			return err
		}
		sum.Add(sum, r)
		if abs(r).Cmp(largestVal) > 0 {
			largest, largestVal = i, abs(r)
		}
	}

	residual := sub(hundred, sum)
	if isZero(residual) || largest < 0 {
		return nil
	}
	current, err := rat(rows[largest].SharePct)
	if err != nil {
		return err
	}
	rows[largest].SharePct = domain.Num(add(current, residual).FloatString(2))
	return nil
}

// ApplyTargets attaches price targets to the holdings they belong to.
//
// Compared in the holding's own currency: a dollar target beside a rupee price
// would read as being 85x away, which is the kind of wrong that looks like a
// screaming buy signal.
func ApplyTargets(sleeves []SleeveReturn, targets []domain.PriceTarget) error {
	byKey := map[string]domain.PriceTarget{}
	for _, t := range targets {
		byKey[t.Sleeve+"\x00"+t.Symbol] = t
	}

	for i := range sleeves {
		for j := range sleeves[i].Holdings {
			h := &sleeves[i].Holdings[j]
			t, ok := byKey[h.Sleeve+"\x00"+h.Symbol]
			if !ok {
				continue
			}
			currency := h.Currency
			if currency == "" {
				currency = "INR"
			}
			if t.Currency != "" && t.Currency != currency {
				// Mismatched units: report the target, refuse the arithmetic.
				h.TargetPrice = t.TargetPrice
				h.TargetHorizon = t.Horizon
				continue
			}
			price, err := rat(h.Price)
			if err != nil {
				return err
			}
			target, err := rat(t.TargetPrice)
			if err != nil {
				return err
			}
			h.TargetPrice = t.TargetPrice
			h.TargetHorizon = t.Horizon
			if !isZero(price) {
				away := mul(sub(target, price), new(big.Rat).SetInt64(100))
				away.Quo(away, price)
				h.TargetAway = domain.Num(away.FloatString(2))
				h.TargetHit = target.Cmp(price) <= 0
			}
		}
	}
	return nil
}
