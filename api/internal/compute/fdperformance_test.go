package compute

import (
	"testing"

	"github.com/harishteens/fingod/api/internal/domain"
)

func twoFDs(t *testing.T) []domain.FixedDeposit {
	return []domain.FixedDeposit{
		{Bank: "Example Bank", Principal: "200000", RatePct: "6.5000",
			StartDate: date(t, "2026-02-01"), MaturityDate: date(t, "2027-02-01"), Compounding: CompoundQuarterly},
		{Bank: "Example Bank", Principal: "300000", RatePct: "6.5000",
			StartDate: date(t, "2026-06-10"), MaturityDate: date(t, "2027-06-10"), Compounding: CompoundQuarterly},
	}
}

func TestFDSleeveValuesBothDeposits(t *testing.T) {
	sleeve, err := FixedDepositReturns(twoFDs(t), date(t, "2026-09-05"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(sleeve.Holdings) != 2 {
		t.Fatalf("got %d rows", len(sleeve.Holdings))
	}
	if sleeve.Invested != "500000.00" {
		t.Errorf("invested = %s, want the combined principal 500000.00", sleeve.Invested)
	}
	if sleeve.Unrealised != "12424.97" {
		t.Errorf("unrealised = %s, want accrued interest 12424.97", sleeve.Unrealised)
	}
	if sleeve.Market != nil {
		t.Error("attribution reported with nothing to compare against")
	}
	// The rate is trimmed for display; 6.5000 is not what anyone typed.
	if got := sleeve.Holdings[0].Name; got[:4] != "6.5%" {
		t.Errorf("row name starts %q, want a trimmed rate", got)
	}
}

func TestFDInterestIsMarketNotFlow(t *testing.T) {
	// Nobody added money — a week of interest is return, and calling it flow
	// would make the deposit look like something being topped up.
	fds := twoFDs(t)
	sleeve, err := FixedDepositReturns(fds, date(t, "2026-09-05"), ptr(date(t, "2026-08-29")))
	if err != nil {
		t.Fatal(err)
	}
	if *sleeve.Flow != "0.00" {
		t.Errorf("flow = %s, want 0.00 — no deposit opened or closed that week", *sleeve.Flow)
	}
	if *sleeve.FX != "0.00" {
		t.Errorf("fx = %s, want 0.00 — a rupee deposit has no currency exposure", *sleeve.FX)
	}
	if FloatOf(*sleeve.Market) <= 0 {
		t.Errorf("market = %s, want a week of interest", *sleeve.Market)
	}
	// The identity holds here as everywhere else.
	sum := add(mustRat(sleeve.Market.String()), mustRat(sleeve.Flow.String()), mustRat(sleeve.FX.String()))
	if sum.Cmp(mustRat(sleeve.Delta.String())) != 0 {
		t.Errorf("market+flow+fx = %s, delta = %s", sum.FloatString(2), *sleeve.Delta)
	}
}

func TestOpeningADepositIsFlow(t *testing.T) {
	// The second deposit started 2026-06-10. Comparing across that date must
	// book the principal as money in, not as a market gain.
	fds := twoFDs(t)
	sleeve, err := FixedDepositReturns(fds, date(t, "2026-07-10"), ptr(date(t, "2026-06-01")))
	if err != nil {
		t.Fatal(err)
	}
	if FloatOf(*sleeve.Flow) < 300000 {
		t.Errorf("flow = %s, want at least the 300000 principal that went in", *sleeve.Flow)
	}
	sum := add(mustRat(sleeve.Market.String()), mustRat(sleeve.Flow.String()), mustRat(sleeve.FX.String()))
	if sum.Cmp(mustRat(sleeve.Delta.String())) != 0 {
		t.Errorf("identity broken: %s vs %s", sum.FloatString(2), *sleeve.Delta)
	}
}

func TestClosedDepositLeavesAsFlowNotLoss(t *testing.T) {
	fds := twoFDs(t)
	closed := date(t, "2026-07-15")
	fds[0].ClosedAt = &closed

	sleeve, err := FixedDepositReturns(fds, date(t, "2026-09-05"), ptr(date(t, "2026-06-20")))
	if err != nil {
		t.Fatal(err)
	}
	if len(sleeve.Holdings) != 1 {
		t.Errorf("a closed deposit is still listed: %d rows", len(sleeve.Holdings))
	}
	if FloatOf(*sleeve.Flow) >= 0 {
		t.Errorf("flow = %s, want negative — the balance left for cash", *sleeve.Flow)
	}
	sum := add(mustRat(sleeve.Market.String()), mustRat(sleeve.Flow.String()), mustRat(sleeve.FX.String()))
	if sum.Cmp(mustRat(sleeve.Delta.String())) != 0 {
		t.Errorf("identity broken on closure: %s vs %s", sum.FloatString(2), *sleeve.Delta)
	}
}

func ptr(d domain.Date) *domain.Date { return &d }
