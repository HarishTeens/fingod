package store

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/harishteens/fingod/api/internal/compute"

	"github.com/harishteens/fingod/api/internal/domain"
)

// CheckpointsWithDetail loads a date range with holdings and balances attached.
//
// Three queries for the whole range rather than three per checkpoint. A year of
// weekly checkpoints is 52 rows, and the per-checkpoint version would be 156
// round trips to render one chart.
func (s *Store) CheckpointsWithDetail(ctx context.Context, from, to *domain.Date) ([]domain.Checkpoint, error) {
	where := ``
	args := []any{}
	if from != nil {
		args = append(args, from.String())
		where += ` AND as_of_date >= $1::text::date`
	}
	if to != nil {
		args = append(args, to.String())
		if len(args) == 1 {
			where += ` AND as_of_date <= $1::text::date`
		} else {
			where += ` AND as_of_date <= $2::text::date`
		}
	}

	rows, err := s.pool.Query(ctx, `
		SELECT id, as_of_date::text, taken_at, usd_inr::text, sources::text, created_at
		  FROM checkpoints
		 WHERE true`+where+`
		 ORDER BY checkpoints.as_of_date`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.Checkpoint{}
	byID := map[int64]int{}
	ids := []int64{}
	for rows.Next() {
		cp, err := scanCheckpoint(rows)
		if err != nil {
			return nil, err
		}
		cp.Holdings, cp.Balances = []domain.Holding{}, []domain.Balance{}
		byID[cp.ID] = len(out)
		ids = append(ids, cp.ID)
		out = append(out, *cp)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return out, nil
	}

	hrows, err := s.pool.Query(ctx, `
		SELECT checkpoint_id, sleeve, symbol, COALESCE(name,''), COALESCE(isin,''),
		       qty::text, price::text, currency, fx_rate::text, value_inr::text,
		       COALESCE(avg_cost::text,''), COALESCE(invested_inr::text,''),
		       COALESCE(invested_usd::text,'')
		  FROM holdings WHERE checkpoint_id = ANY($1)
		 ORDER BY sleeve, holdings.value_inr DESC`, ids)
	if err != nil {
		return nil, err
	}
	defer hrows.Close()
	for hrows.Next() {
		var id int64
		var h domain.Holding
		if err := hrows.Scan(&id, &h.Sleeve, &h.Symbol, &h.Name, &h.ISIN,
			&h.Qty, &h.Price, &h.Currency, &h.FXRate, &h.ValueINR,
			&h.AvgCost, &h.InvestedINR, &h.InvestedUSD); err != nil {
			return nil, err
		}
		out[byID[id]].Holdings = append(out[byID[id]].Holdings, h)
	}
	if err := hrows.Err(); err != nil {
		return nil, err
	}

	brows, err := s.pool.Query(ctx, `
		SELECT checkpoint_id, kind, ref, amount_inr::text, meta::text
		  FROM balances WHERE checkpoint_id = ANY($1)
		 ORDER BY kind, ref`, ids)
	if err != nil {
		return nil, err
	}
	defer brows.Close()
	for brows.Next() {
		var id int64
		var b domain.Balance
		var meta string
		if err := brows.Scan(&id, &b.Kind, &b.Ref, &b.AmountINR, &meta); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(meta), &b.Meta); err != nil {
			return nil, err
		}
		out[byID[id]].Balances = append(out[byID[id]].Balances, b)
	}
	return out, brows.Err()
}

// ExpenseBucket is one period of the expense series.
//
// Investments are kept apart from spend rather than summed into it. Wallet
// records SIP money as an `Investments` expense — often several times
// actual consumption — so folding them together would make the chart mostly
// a picture of SIP dates. Transfers between own accounts are excluded outright.
type ExpenseBucket struct {
	Period      string     `json:"period"`
	Spend       domain.Num `json:"spend"`
	Investments domain.Num `json:"investments"`
	Income      domain.Num `json:"income"`
	Count       int        `json:"count"`
}

// What counts as money going into investments rather than being spent.
//
// Two rules, because Wallet carries the fact in two places and neither is a
// superset. Some records wear the label without sitting in the category — an
// insurance premium filed under `Financial expenses`, say, which is a
// contribution wearing a consumption category.
//
// Matched by name: Wallet's category and label ids are per-user, and the names
// are what you see in the app.
const (
	InvestmentCategory = "Investments"
	InvestmentLabel    = "Investment"
)

// TransferCategoryID is Wallet's auto-managed Transfer category. Unlike
// everything else here it is a fixed registry id, identical for every user.
//
// `is_transfer` alone is not enough. It reflects Wallet's `transfer` object,
// which is null once a transfer loses its mirror record — some records sit in
// the Transfer category with `transfer: null`, including the money that opened
// a fixed deposit. Every one was being counted as spending. A record filed under Transfer is money moving, whether or not its
// other leg survived.
const TransferCategoryID = "5c5c4e21-00c8-8000-8000-000000000000"

func (s *Store) ExpenseSeries(ctx context.Context, granularity string, from, to *domain.Date) ([]ExpenseBucket, error) {
	unit := "month"
	if granularity == "week" {
		unit = "week"
	}

	args := []any{unit, InvestmentCategory, InvestmentLabel, TransferCategoryID}
	where := ""
	if from != nil {
		args = append(args, from.String())
		where += ` AND t.txn_date >= $` + itoa(len(args)) + `::text::date`
	}
	if to != nil {
		args = append(args, to.String())
		where += ` AND t.txn_date <= $` + itoa(len(args)) + `::text::date`
	}

	// Investments and income are gross figures and stay that way. Spend comes
	// from the netted per-label view instead, so the headline number and the
	// stacked chart can never disagree — they are the same arithmetic.
	rows, err := s.pool.Query(ctx, `
		SELECT to_char(date_trunc($1, txn_date), 'YYYY-MM-DD'),
		       COALESCE(sum(-amount_inr) FILTER (WHERE amount_inr < 0 AND category_top = $2), 0)::text,
		       COALESCE(sum(amount_inr)  FILTER (WHERE amount_inr > 0), 0)::text,
		       count(*)
		  FROM transactions t
		 WHERE NOT t.is_transfer
		   AND COALESCE(t.category_id, '') <> $4
		   AND NOT (COALESCE(t.category, '') <> 'Insurances'
		            AND EXISTS (SELECT 1 FROM transaction_labels l
		                         WHERE l.transaction_id = t.id AND l.label = $3))`+where+`
		 GROUP BY 1 ORDER BY 1`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byPeriod := map[string]*ExpenseBucket{}
	order := []string{}
	for rows.Next() {
		var b ExpenseBucket
		if err := rows.Scan(&b.Period, &b.Investments, &b.Income, &b.Count); err != nil {
			return nil, err
		}
		b.Spend = "0.00"
		byPeriod[b.Period] = &b
		order = append(order, b.Period)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	cells, err := s.labelNets(ctx, granularity, from, to)
	if err != nil {
		return nil, err
	}
	for _, c := range cells {
		if floatOf(c.Net) <= 0 {
			continue // clamped, exactly as the chart clamps it
		}
		b := byPeriod[c.Period]
		if b == nil {
			b = &ExpenseBucket{Period: c.Period, Spend: "0.00", Investments: "0.00", Income: "0.00"}
			byPeriod[c.Period] = b
			order = append(order, c.Period)
		}
		b.Spend = addMoneyStr(b.Spend, c.Net)
	}

	sort.Strings(order)
	out := make([]ExpenseBucket, 0, len(order))
	seen := map[string]bool{}
	for _, p := range order {
		if seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, *byPeriod[p])
	}
	return out, nil
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return string(rune('0'+n/10)) + string(rune('0'+n%10))
}

func addMoneyStr(a, b domain.Num) domain.Num { return compute.AddMoneyStrings(a, b) }

func floatOf(n domain.Num) float64 { return compute.FloatOf(n) }
