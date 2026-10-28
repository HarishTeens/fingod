package compute

import (
	"testing"

	"github.com/harishteens/fingod/api/internal/domain"
)

func trade(symbol, exit, invested, realised string, days int) domain.Trade {
	d, _ := domain.ParseDate(exit)
	return domain.Trade{
		Sleeve: "in_equity", Symbol: symbol, ExitDate: d,
		InvestedINR: domain.Num(invested), RealisedINR: domain.Num(realised),
		HoldingDays: &days,
	}
}

func TestSummariseAddsUpTheBook(t *testing.T) {
	trades := []domain.Trade{
		trade("AAA", "2025-05-20", "10000", "3000", 90),
		trade("BBB", "2025-10-01", "30000", "-7000", 120),
		trade("CCC", "2026-06-01", "40000", "-11000", 200),
	}
	s, err := Summarise(trades)
	if err != nil {
		t.Fatal(err)
	}
	if s.Realised != "-15000.00" {
		t.Errorf("realised = %s, want -15000.00", s.Realised)
	}
	if s.Winners != 1 || s.Losers != 2 {
		t.Errorf("%dW/%dL, want 1W/2L", s.Winners, s.Losers)
	}
	// Gross wins and losses must not net off — the point of showing both is
	// that ₹1.2L won against ₹48k lost is a different story from ₹72k netted.
	if s.GrossWins != "3000.00" || s.GrossLosses != "-18000.00" {
		t.Errorf("gross %s / %s", s.GrossWins, s.GrossLosses)
	}
	if s.Best.Symbol != "AAA" || s.Worst.Symbol != "CCC" {
		t.Errorf("best %s worst %s", s.Best.Symbol, s.Worst.Symbol)
	}
	if s.AvgHoldDays != 136 {
		t.Errorf("avg hold %d days, want 136", s.AvgHoldDays)
	}
}

func TestBreakEvenCountsAsALoser(t *testing.T) {
	// It consumed the position and returned nothing. For a strategy built on
	// hitting targets, calling that a win would flatter the hit rate.
	s, err := Summarise([]domain.Trade{trade("X", "2026-01-01", "1000", "0", 30)})
	if err != nil {
		t.Fatal(err)
	}
	if s.Winners != 0 || s.Losers != 1 {
		t.Errorf("break-even counted as %dW/%dL", s.Winners, s.Losers)
	}
}

func TestBucketedOnExitNotEntry(t *testing.T) {
	// Held across a year boundary, sold in 2026: all of it lands in 2026.
	buy, _ := domain.ParseDate("2024-03-01")
	tr := trade("X", "2026-07-15", "1000", "500", 866)
	tr.BuyDate = &buy

	byYear, err := ByPeriod([]domain.Trade{tr}, "year")
	if err != nil {
		t.Fatal(err)
	}
	if len(byYear) != 1 || byYear[0].Period != "2026-01-01" {
		t.Fatalf("buckets = %+v, want one in 2026", byYear)
	}
	if byYear[0].Realised != "500.00" {
		t.Errorf("realised = %s, want the whole 500 in the exit year", byYear[0].Realised)
	}
}
