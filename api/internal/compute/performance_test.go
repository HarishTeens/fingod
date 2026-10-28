package compute

import (
	"testing"

	"github.com/harishteens/fingod/api/internal/domain"
)

func holding(sleeve, symbol, qty, price, value, invested string) domain.Holding {
	return domain.Holding{
		Sleeve: sleeve, Symbol: symbol, ISIN: symbol,
		Qty: domain.Num(qty), Price: domain.Num(price), FXRate: "1",
		Currency: "INR", ValueINR: domain.Num(value), InvestedINR: domain.Num(invested),
	}
}

func TestReturnsMatchTheSourcesOwnFigures(t *testing.T) {
	// A synthetic US sleeve. If this drifts, the meaning of "return" has changed.
	now := []domain.Holding{
		{Sleeve: "us_equity", Symbol: "ACME", Qty: "2", Price: "500.00", FXRate: "90",
			Currency: "USD", ValueINR: "90000.00", InvestedINR: "80000.00"},
		{Sleeve: "us_equity", Symbol: "BETA", Qty: "1", Price: "400.00", FXRate: "90",
			Currency: "USD", ValueINR: "36000.00", InvestedINR: "30000.00"},
	}
	sleeves, total, err := Returns(now, nil, "0.25")
	if err != nil {
		t.Fatal(err)
	}
	if len(sleeves) != 1 {
		t.Fatalf("got %d sleeves", len(sleeves))
	}
	if got := sleeves[0].Unrealised; got != "16000.00" {
		t.Errorf("unrealised = %s, want 16000.00", got)
	}
	// (126000 - 110000) / 110000
	if got := total.ReturnPct; got != "14.55" {
		t.Errorf("return = %s%%, want 14.55%%", got)
	}
	if total.Partial {
		t.Error("marked partial when every holding had cost basis")
	}
}

func TestMissingCostBasisIsFlaggedNotHidden(t *testing.T) {
	// A sleeve where one holding has no cost basis would otherwise report a
	// flattering return: full value over partial invested.
	now := []domain.Holding{
		holding("btc", "BTC", "1", "100", "100", "80"),
		holding("btc", "ETH", "1", "100", "100", ""),
	}
	sleeves, total, err := Returns(now, nil, "0.25")
	if err != nil {
		t.Fatal(err)
	}
	if !sleeves[0].Partial || !total.Partial {
		t.Error("a holding with no cost basis did not mark the group partial")
	}
	if sleeves[0].Invested != "80.00" {
		t.Errorf("invested = %s, want 80.00 — the missing one must not be invented", sleeves[0].Invested)
	}
}

func TestAttributionAppearsOnlyWithAComparison(t *testing.T) {
	now := []domain.Holding{holding("in_equity", "ACME", "400", "120.00", "48000.00", "40000.00")}

	sleeves, _, err := Returns(now, nil, "0.25")
	if err != nil {
		t.Fatal(err)
	}
	if sleeves[0].Market != nil || sleeves[0].Holdings[0].Market != nil {
		t.Error("attribution reported with nothing to compare against")
	}

	prev := []domain.Holding{holding("in_equity", "ACME", "400", "100.00", "40000.00", "40000.00")}
	sleeves, _, err = Returns(now, prev, "0.25")
	if err != nil {
		t.Fatal(err)
	}
	s := sleeves[0]
	if s.Market == nil {
		t.Fatal("no attribution with a comparison checkpoint")
	}
	// Price moved, quantity did not: all market, no flow.
	if *s.Market != "8000.00" {
		t.Errorf("market = %s, want 8000.00", *s.Market)
	}
	if *s.Flow != "0.00" || *s.FX != "0.00" {
		t.Errorf("flow %s / fx %s, both want 0.00", *s.Flow, *s.FX)
	}
	// Since-inception return is unaffected by the comparison — different question.
	if s.ReturnPct != "20.00" {
		t.Errorf("return = %s%%, want 20.00%%", s.ReturnPct)
	}
}

func TestSleevesSortedByValue(t *testing.T) {
	now := []domain.Holding{
		holding("btc", "BTC", "1", "100", "100", "80"),
		holding("in_mf", "FUND", "1", "5000", "5000", "4000"),
		holding("gold", "GOLDETF", "1", "900", "900", "700"),
	}
	sleeves, _, err := Returns(now, nil, "0.25")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"in_mf", "gold", "btc"}
	for i, s := range sleeves {
		if s.Sleeve != want[i] {
			t.Errorf("position %d is %s, want %s", i, s.Sleeve, want[i])
		}
	}
}

func TestSharesSumToExactlyOneHundred(t *testing.T) {
	// Thirty-one rounded percentages will not sum to 100 on their own, and a
	// column visibly totalling 100.03 invites a hunt for the missing holding.
	now := make([]domain.Holding, 0, 31)
	for i := 1; i <= 31; i++ {
		v := 1000 + i*137 // deliberately unroundable
		now = append(now, holding("in_equity", string(rune('A'+i%26))+string(rune('a'+i)),
			"1", "1", itoaTest(v), "1"))
	}
	sleeves, _, err := Returns(now, nil, "0.25")
	if err != nil {
		t.Fatal(err)
	}
	sum := mustRat("0")
	for _, h := range sleeves[0].Holdings {
		if h.SharePct.Empty() {
			t.Fatalf("%s has no share", h.Symbol)
		}
		sum.Add(sum, mustRat(h.SharePct.String()))
	}
	if sum.Cmp(mustRat("100")) != 0 {
		t.Errorf("shares sum to %s, want exactly 100", sum.FloatString(4))
	}
}

func itoaTest(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
