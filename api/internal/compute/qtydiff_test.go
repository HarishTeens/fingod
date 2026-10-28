package compute

import (
	"math/big"
	"math/rand"
	"testing"

	"github.com/harishteens/fingod/api/internal/domain"
)

// TestIdentityHoldsExactly is the single most important test in the codebase.
//
// If market + flow + fx == Δvalue for arbitrary inputs, then every growth
// number fingod reports is right by construction, and no amount of UI can make
// contribution look like gain. Exact rationals let this be an equality rather
// than a tolerance, so any failure is a real defect and never drift.
func TestIdentityHoldsExactly(t *testing.T) {
	rng := rand.New(rand.NewSource(20260905))

	for i := 0; i < 20000; i++ {
		prev := randomPosition(rng)
		now := randomPosition(rng)
		now.Sleeve, now.Symbol, now.ISIN = prev.Sleeve, prev.Symbol, prev.ISIN

		e, err := decompose(prev, now, false, false)
		if err != nil {
			t.Fatal(err)
		}
		if got := add(e.market, e.flow, e.fx); got.Cmp(e.delta) != 0 {
			t.Fatalf("iteration %d: market+flow+fx = %s, delta = %s\n  prev %+v\n  now  %+v",
				i, got.FloatString(12), e.delta.FloatString(12), prev, now)
		}
	}
}

// TestRoundedPartsSumToTheRoundedTotal guards the thing a user actually sees:
// three figures printed beside a total they are supposed to add up to.
func TestRoundedPartsSumToTheRoundedTotal(t *testing.T) {
	rng := rand.New(rand.NewSource(7))

	for i := 0; i < 20000; i++ {
		prev := randomPosition(rng)
		now := randomPosition(rng)
		now.Sleeve, now.Symbol, now.ISIN = prev.Sleeve, prev.Symbol, prev.ISIN

		attrs, err := Diff([]Position{prev}, []Position{now})
		if err != nil {
			t.Fatal(err)
		}
		a := attrs[0]
		sum := add(mustRat(a.Market.String()), mustRat(a.Flow.String()), mustRat(a.FX.String()))
		if sum.Cmp(mustRat(a.Delta.String())) != 0 {
			t.Fatalf("iteration %d: %s + %s + %s != %s", i, a.Market, a.Flow, a.FX, a.Delta)
		}
	}
}

func randomPosition(rng *rand.Rand) Position {
	dec := func(maxWhole int, places int) domain.Num {
		whole := rng.Intn(maxWhole)
		frac := rng.Intn(pow10(places))
		return domain.Num(bigDec(whole, frac, places))
	}
	fx := domain.Num("1")
	if rng.Intn(2) == 0 {
		fx = dec(120, 6) // a plausible USD/INR, plus implausible ones on purpose
		if fx == "0" || fx.String()[0] == '0' && len(fx.String()) > 1 && fx.String()[1] == '.' {
			fx = "87.500000"
		}
	}
	return Position{
		Sleeve: "in_equity", Symbol: "TEST", ISIN: "INE000A01000",
		Qty:    dec(50000, 8),
		Price:  dec(10000, 6),
		FXRate: fx,
	}
}

func pow10(n int) int {
	p := 1
	for i := 0; i < n; i++ {
		p *= 10
	}
	return p
}

func bigDec(whole, frac, places int) string {
	s := new(big.Int).SetInt64(int64(frac)).String()
	for len(s) < places {
		s = "0" + s
	}
	return new(big.Int).SetInt64(int64(whole)).String() + "." + s
}

// --- the scenarios the plan calls out by name ------------------------------

func TestContributionIsNeverReportedAsGain(t *testing.T) {
	// qty rises, price unchanged: the entire move is money added.
	prev := Position{Sleeve: "in_mf", Symbol: "INF000F01001", ISIN: "INF000F01001", Qty: "1000", Price: "50.00", FXRate: "1"}
	now := prev
	now.Qty = "1100.5"

	a := diffOne(t, prev, now)
	if a.Market != "0.00" {
		t.Errorf("market = %s, want 0.00 — a SIP instalment is not a market gain", a.Market)
	}
	if a.FX != "0.00" {
		t.Errorf("fx = %s, want 0.00 on an INR holding", a.FX)
	}
	if a.Flow != a.Delta {
		t.Errorf("flow %s should be the whole delta %s", a.Flow, a.Delta)
	}
}

func TestGainIsNeverReportedAsContribution(t *testing.T) {
	// price rises, qty unchanged: the entire move is market.
	prev := Position{Sleeve: "in_equity", Symbol: "GOLDETF", ISIN: "INF000G01001", Qty: "200", Price: "100.00", FXRate: "1"}
	now := prev
	now.Price = "120.00"

	a := diffOne(t, prev, now)
	if a.Flow != "0.00" {
		t.Errorf("flow = %s, want 0.00 — nothing was bought", a.Flow)
	}
	if a.Market != a.Delta {
		t.Errorf("market %s should be the whole delta %s", a.Market, a.Delta)
	}
}

func TestFXIsIsolatedFromMarket(t *testing.T) {
	// Same units, same USD price, the rupee moved. Booking this as market gain
	// is exactly the error the third term exists to prevent.
	prev := Position{Sleeve: "us_equity", Symbol: "ACME", Qty: "2", Price: "500", FXRate: "85.000000"}
	now := prev
	now.FXRate = "90.000000"

	a := diffOne(t, prev, now)
	if a.Market != "0.00" {
		t.Errorf("market = %s, want 0.00 — the stock did not move, the rupee did", a.Market)
	}
	if a.Flow != "0.00" {
		t.Errorf("flow = %s, want 0.00", a.Flow)
	}
	if a.FX != a.Delta {
		t.Errorf("fx %s should be the whole delta %s", a.FX, a.Delta)
	}
	// 2 x 500 x (90 - 85)
	if a.FX != "5000.00" {
		t.Errorf("fx = %s, want 5000.00", a.FX)
	}
}

func TestNewPositionIsAllFlow(t *testing.T) {
	now := Position{Sleeve: "us_equity", Symbol: "NEWCO", Qty: "10", Price: "20.00", FXRate: "90"}
	attrs, err := Diff(nil, []Position{now})
	if err != nil {
		t.Fatal(err)
	}
	a := attrs[0]
	if !a.New {
		t.Error("not marked as new")
	}
	if a.Market != "0.00" || a.FX != "0.00" {
		t.Errorf("market %s / fx %s, both want 0.00", a.Market, a.FX)
	}
	if a.Flow != "18000.00" || a.Delta != "18000.00" {
		t.Errorf("flow %s delta %s, want 18000.00 (10 x 20 x 90)", a.Flow, a.Delta)
	}
}

func TestExitedPositionBooksAnOutflowNotATotalLoss(t *testing.T) {
	// The naive reading — no row means price zero — would report the entire
	// holding as a market loss the week it was sold.
	prev := Position{Sleeve: "in_equity", Symbol: "ALPHA", ISIN: "INE000A01001", Qty: "100", Price: "200.00", FXRate: "1"}
	attrs, err := Diff([]Position{prev}, nil)
	if err != nil {
		t.Fatal(err)
	}
	a := attrs[0]
	if !a.Exited {
		t.Error("not marked as exited")
	}
	if a.Market != "0.00" {
		t.Errorf("market = %s, want 0.00 — the sale is not a price move", a.Market)
	}
	if a.Flow != "-20000.00" {
		t.Errorf("flow = %s, want -20000.00", a.Flow)
	}
	if a.Delta != "-20000.00" {
		t.Errorf("delta = %s, want -20000.00", a.Delta)
	}
}

func TestRenameIsNotAnExitAndAnEntry(t *testing.T) {
	// OLDNAME became NEWNAME. Matching on ticker would produce a -₹20,000
	// phantom outflow and a +₹15,000 phantom inflow in the same period.
	prev := Position{Sleeve: "in_equity", Symbol: "OLDNAME", ISIN: "INE000B01002", Qty: "50", Price: "400", FXRate: "1"}
	now := Position{Sleeve: "in_equity", Symbol: "NEWNAME", ISIN: "INE000B01002", Qty: "50", Price: "300", FXRate: "1"}

	attrs, err := Diff([]Position{prev}, []Position{now})
	if err != nil {
		t.Fatal(err)
	}
	if len(attrs) != 1 {
		t.Fatalf("a rename produced %d rows, want 1", len(attrs))
	}
	a := attrs[0]
	if a.Symbol != "NEWNAME" {
		t.Errorf("reported under %s, want the current ticker NEWNAME", a.Symbol)
	}
	if a.New || a.Exited {
		t.Error("a rename was read as a new or exited position")
	}
	if a.Flow != "0.00" {
		t.Errorf("flow = %s, want 0.00 — no money moved, only the name", a.Flow)
	}
	if a.Market != a.Delta {
		t.Errorf("market %s should be the whole delta %s", a.Market, a.Delta)
	}
}

func TestSleeveRollupAndFlowFlag(t *testing.T) {
	prev := []Position{
		{Sleeve: "in_equity", Symbol: "ALPHA", ISIN: "INE000A01001", Qty: "100", Price: "100.00", FXRate: "1"},
		{Sleeve: "in_equity", Symbol: "BONUSCO", ISIN: "INE000C01003", Qty: "500", Price: "200.00", FXRate: "1"},
		{Sleeve: "gold", Symbol: "GOLDETF", ISIN: "INF000G01001", Qty: "200", Price: "100.00", FXRate: "1"},
	}
	now := []Position{
		{Sleeve: "in_equity", Symbol: "ALPHA", ISIN: "INE000A01001", Qty: "100", Price: "110.00", FXRate: "1"},
		// A 1:1 bonus doubles the units with no money in. It has to be flagged.
		{Sleeve: "in_equity", Symbol: "BONUSCO", ISIN: "INE000C01003", Qty: "1000", Price: "220.00", FXRate: "1"},
		{Sleeve: "gold", Symbol: "GOLDETF", ISIN: "INF000G01001", Qty: "200", Price: "120.00", FXRate: "1"},
	}

	attrs, err := Diff(prev, now)
	if err != nil {
		t.Fatal(err)
	}
	sleeves, err := BySleeve(attrs, "0.25")
	if err != nil {
		t.Fatal(err)
	}
	if len(sleeves) != 2 {
		t.Fatalf("got %d sleeves, want 2", len(sleeves))
	}

	for _, s := range sleeves {
		sum := add(mustRat(s.Market.String()), mustRat(s.Flow.String()), mustRat(s.FX.String()))
		if sum.Cmp(mustRat(s.Delta.String())) != 0 {
			t.Errorf("%s: parts %s do not sum to delta %s", s.Sleeve, sum.FloatString(2), s.Delta)
		}
	}

	var flagged []string
	for _, s := range sleeves {
		for _, h := range s.Holdings {
			if h.Flagged {
				flagged = append(flagged, h.Symbol)
			}
		}
	}
	if len(flagged) != 1 || flagged[0] != "BONUSCO" {
		t.Errorf("flagged %v, want only the bonus issue BONUSCO", flagged)
	}
}

func diffOne(t *testing.T, prev, now Position) Attribution {
	t.Helper()
	attrs, err := Diff([]Position{prev}, []Position{now})
	if err != nil {
		t.Fatal(err)
	}
	if len(attrs) != 1 {
		t.Fatalf("got %d attributions, want 1", len(attrs))
	}
	return attrs[0]
}
