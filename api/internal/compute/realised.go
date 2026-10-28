package compute

import (
	"math/big"
	"sort"

	"github.com/harishteens/fingod/api/internal/domain"
)

// RealisedSummary is what closed positions add up to.
//
// Win rate and average holding are here because "how am I doing" on a strategy
// of selling at a target is not answered by a profit figure alone: ₹70,000 made
// on 20 trades with 14 winners is a different story from the same total made on
// one lucky trade and 19 losses.
type RealisedSummary struct {
	Trades      int        `json:"trades"`
	Invested    domain.Num `json:"invested"`
	Realised    domain.Num `json:"realised"`
	ReturnPct   domain.Num `json:"return_pct,omitempty"`
	Winners     int        `json:"winners"`
	Losers      int        `json:"losers"`
	WinRatePct  domain.Num `json:"win_rate_pct,omitempty"`
	GrossWins   domain.Num `json:"gross_wins"`
	GrossLosses domain.Num `json:"gross_losses"`
	AvgHoldDays int        `json:"avg_holding_days,omitempty"`
	Best        *TradeRef  `json:"best,omitempty"`
	Worst       *TradeRef  `json:"worst,omitempty"`
}

type TradeRef struct {
	Symbol    string     `json:"symbol"`
	Realised  domain.Num `json:"realised"`
	ReturnPct domain.Num `json:"return_pct,omitempty"`
	ExitDate  string     `json:"exit_date"`
}

// RealisedPeriod is one bucket of the realised-profit series.
type RealisedPeriod struct {
	Period   string     `json:"period"`
	Realised domain.Num `json:"realised"`
	Invested domain.Num `json:"invested"`
	Trades   int        `json:"trades"`
	Winners  int        `json:"winners"`
}

// Summarise folds a list of closed trades.
func Summarise(trades []domain.Trade) (*RealisedSummary, error) {
	out := &RealisedSummary{
		Trades: len(trades), Invested: "0.00", Realised: "0.00",
		GrossWins: "0.00", GrossLosses: "0.00",
	}
	invested, realised := new(big.Rat), new(big.Rat)
	wins, losses := new(big.Rat), new(big.Rat)
	days, withDays := 0, 0
	var best, worst *domain.Trade

	for i := range trades {
		t := &trades[i]
		inv, err := rat(t.InvestedINR)
		if err != nil {
			return nil, err
		}
		re, err := rat(t.RealisedINR)
		if err != nil {
			return nil, err
		}
		invested.Add(invested, inv)
		realised.Add(realised, re)

		if re.Sign() > 0 {
			out.Winners++
			wins.Add(wins, re)
		} else {
			// Break-even counts as a loser: it consumed the position and
			// returned nothing, which is the honest reading for a strategy
			// built on hitting targets.
			out.Losers++
			losses.Add(losses, re)
		}
		if t.HoldingDays != nil {
			days += *t.HoldingDays
			withDays++
		}
		if best == nil || FloatOf(t.RealisedINR) > FloatOf(best.RealisedINR) {
			best = t
		}
		if worst == nil || FloatOf(t.RealisedINR) < FloatOf(worst.RealisedINR) {
			worst = t
		}
	}

	out.Invested, out.Realised = money(invested), money(realised)
	out.GrossWins, out.GrossLosses = money(wins), money(losses)
	if !isZero(invested) {
		out.ReturnPct = PctOf(out.Realised, out.Invested)
	}
	if len(trades) > 0 {
		rate := mul(new(big.Rat).SetInt64(int64(out.Winners)), new(big.Rat).SetInt64(100))
		rate.Quo(rate, new(big.Rat).SetInt64(int64(len(trades))))
		out.WinRatePct = domain.Num(rate.FloatString(1))
	}
	if withDays > 0 {
		out.AvgHoldDays = days / withDays
	}
	if best != nil {
		out.Best = &TradeRef{best.Symbol, best.RealisedINR, PctOf(best.RealisedINR, best.InvestedINR), best.ExitDate.String()}
	}
	if worst != nil {
		out.Worst = &TradeRef{worst.Symbol, worst.RealisedINR, PctOf(worst.RealisedINR, worst.InvestedINR), worst.ExitDate.String()}
	}
	return out, nil
}

// ByPeriod buckets realised profit by the month or year a position was closed.
//
// Bucketed on the **exit** date, not the buy date: the profit became real the
// day it was sold, and a trade held across three years did not earn a third of
// it in each.
func ByPeriod(trades []domain.Trade, granularity string) ([]RealisedPeriod, error) {
	key := func(d domain.Date) string {
		if granularity == "year" {
			return d.Time.Format("2006") + "-01-01"
		}
		return d.Time.Format("2006-01") + "-01"
	}

	buckets := map[string]*RealisedPeriod{}
	sums := map[string][2]*big.Rat{}
	for i := range trades {
		t := &trades[i]
		k := key(t.ExitDate)
		if buckets[k] == nil {
			buckets[k] = &RealisedPeriod{Period: k}
			sums[k] = [2]*big.Rat{new(big.Rat), new(big.Rat)}
		}
		re, err := rat(t.RealisedINR)
		if err != nil {
			return nil, err
		}
		inv, err := rat(t.InvestedINR)
		if err != nil {
			return nil, err
		}
		sums[k][0].Add(sums[k][0], re)
		sums[k][1].Add(sums[k][1], inv)
		buckets[k].Trades++
		if re.Sign() > 0 {
			buckets[k].Winners++
		}
	}

	out := make([]RealisedPeriod, 0, len(buckets))
	for k, b := range buckets {
		b.Realised, b.Invested = money(sums[k][0]), money(sums[k][1])
		out = append(out, *b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Period < out[j].Period })
	return out, nil
}

// DividendSummary folds payouts, bucketed the same way trades are.
type DividendSummary struct {
	Count    int               `json:"count"`
	Total    domain.Num        `json:"total"`
	First    string            `json:"first,omitempty"`
	Last     string            `json:"last,omitempty"`
	Series   []RealisedPeriod  `json:"series"`
	Payments []domain.Dividend `json:"payments,omitempty"`
}

// SummariseDividends totals payouts and buckets them by period.
func SummariseDividends(divs []domain.Dividend, granularity string) (*DividendSummary, error) {
	out := &DividendSummary{Count: len(divs), Total: "0.00", Series: []RealisedPeriod{}, Payments: divs}
	total := new(big.Rat)
	buckets := map[string]*big.Rat{}
	counts := map[string]int{}

	for _, d := range divs {
		v, err := rat(d.AmountINR)
		if err != nil {
			return nil, err
		}
		total.Add(total, v)

		k := d.Date.Time.Format("2006-01") + "-01"
		if granularity == "year" {
			k = d.Date.Time.Format("2006") + "-01-01"
		}
		if buckets[k] == nil {
			buckets[k] = new(big.Rat)
		}
		buckets[k].Add(buckets[k], v)
		counts[k]++
	}
	out.Total = money(total)

	keys := make([]string, 0, len(buckets))
	for k := range buckets {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out.Series = append(out.Series, RealisedPeriod{
			Period: k, Realised: money(buckets[k]), Invested: "0.00", Trades: counts[k],
		})
	}
	if len(divs) > 0 {
		// Sorted newest first on the way in.
		out.Last = divs[0].Date.String()
		out.First = divs[len(divs)-1].Date.String()
	}
	return out, nil
}
