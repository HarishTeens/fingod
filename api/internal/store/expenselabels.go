package store

import (
	"context"
	"sort"

	"github.com/harishteens/fingod/api/internal/compute"

	"github.com/harishteens/fingod/api/internal/domain"
)

// UntaggedLabel is the bucket for spend carrying no label at all. Always
// emitted, never hidden: a breakdown that quietly drops untagged spend is a
// breakdown that does not add up.
const UntaggedLabel = "Untagged"

// ModifierLabels describe *how* a record was paid rather than *what* it was
// for, so they lose to any label that answers the second question. A ₹40,000
// dinner tagged `Split + Beach Trip` is a Beach Trip expense in full;
// halving it between the two would have said the trip cost ₹20,000 less than it
// did, and put the other half under a heading that is not a spending category
// at all.
//
// A record whose only label is a modifier keeps it — the alternative is the
// amount vanishing, and a bucket that quietly loses money is worse than one
// with an awkward name.
var ModifierLabels = []string{"Split"}

// OtherLabel absorbs everything past the palette's capacity of eight — the
// practical ceiling for distinguishable categorical hues, so a ninth series is
// folded rather than handed a generated colour nobody can tell from the eighth.
//
// Ranking is over the requested range, not all of history, which is the whole
// reason callers should ask for the range they intend to draw. Ranking 79
// months while showing 18 sent a label that dominated a recent month into Other
// because a different one was bigger three years earlier.
const OtherLabel = "Other"

// LabelBucket is one period's spend split by label.
type LabelBucket struct {
	Period   string                `json:"period"`
	Total    domain.Num            `json:"total"`
	Segments map[string]domain.Num `json:"segments"`

	// NetInflow is money that came back beyond what went out, under labels that
	// ended the period net positive. Surfaced rather than folded away: it is
	// not spending, but it is not nothing either.
	NetInflow domain.Num `json:"net_inflow"`
}

// ExpenseByLabel splits spend across labels, period by period.
//
// Labels are many-to-many, so they are not naturally a partition — a
// transaction with two labels would be counted twice and the stack would stand
// taller than the spending it represents. Two rules make them one:
//
//  1. Modifier labels (see ModifierLabels) drop out when the record carries
//     anything else, so the whole amount lands on the label that describes what
//     was bought.
//  2. Whatever survives shares the amount evenly.
//
// Together they keep every bar exactly as tall as that period's spend. Rule 1
// removes almost all the guesswork — it is what the remaining overlaps looked
// like in practice — and where rule 2 still applies the division is arbitrary
// while the total is not. For a stacked bar the total is the thing that must
// not lie.
// ExpenseByLabel splits a period's spend across labels, net of anything that
// came back under the same label.
//
// Netting is the difference between "what passed through my account" and "what
// this cost me": a beach trip shows ₹1,00,000 of outgoings and ₹60,000
// of friends paying their share, and only the ₹40,000 difference is spending.
//
// A label where more came back than went out is **clamped to zero** rather than
// drawn negative — a bar has no negative length, and a Freelance label taking in
// ₹60,000 against ₹500 of costs is income wearing a label, not a refund. The
// clamped amount is returned as NetInflow rather than dropped, because a number
// that vanishes silently is a number nobody can check.
func (s *Store) ExpenseByLabel(ctx context.Context, granularity string, from, to *domain.Date, top int) ([]LabelBucket, []string, error) {
	if top <= 0 {
		top = 8
	}
	cells, err := s.labelNets(ctx, granularity, from, to)
	if err != nil {
		return nil, nil, err
	}

	totals := map[string]float64{}
	for _, c := range cells {
		if v := floatOf(c.Net); v > 0 && c.Label != UntaggedLabel {
			totals[c.Label] += v
		}
	}
	ranked := make([]string, 0, len(totals))
	for l := range totals {
		ranked = append(ranked, l)
	}
	sort.Slice(ranked, func(i, j int) bool { return totals[ranked[i]] > totals[ranked[j]] })

	keep := map[string]bool{UntaggedLabel: true}
	for i, l := range ranked {
		if i < top {
			keep[l] = true
		}
	}

	buckets := map[string]*LabelBucket{}
	var order []string
	for _, c := range cells {
		b := buckets[c.Period]
		if b == nil {
			b = &LabelBucket{Period: c.Period, Segments: map[string]domain.Num{}, Total: "0.00", NetInflow: "0.00"}
			buckets[c.Period] = b
			order = append(order, c.Period)
		}
		if floatOf(c.Net) < 0 {
			// More came back than went out under this label, this period.
			b.NetInflow = addMoneyStr(b.NetInflow, compute.SubMoneyStrings("0.00", c.Net))
			continue
		}
		name := c.Label
		if !keep[name] {
			name = OtherLabel
		}
		b.Segments[name] = addMoneyStr(b.Segments[name], c.Net)
		b.Total = addMoneyStr(b.Total, c.Net)
	}

	sort.Strings(order)
	out := make([]LabelBucket, 0, len(order))
	for _, p := range order {
		out = append(out, *buckets[p])
	}

	series := []string{}
	for i, l := range ranked {
		if i < top {
			series = append(series, l)
		}
	}
	if len(ranked) > top {
		series = append(series, OtherLabel)
	}
	for _, c := range cells {
		if c.Label == UntaggedLabel && floatOf(c.Net) > 0 {
			series = append(series, UntaggedLabel)
			break
		}
	}
	return out, series, nil
}
