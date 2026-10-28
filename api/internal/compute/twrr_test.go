package compute

import (
	"math/big"
	"testing"

	"github.com/harishteens/fingod/api/internal/domain"
)

func day(s string) domain.Date {
	d, err := domain.ParseDate(s)
	if err != nil {
		panic(err)
	}
	return d
}

func pt(date, value, flow string) SeriesPoint {
	p := SeriesPoint{Date: day(date), Value: mustRat(value)}
	if flow != "" {
		p.Flow = mustRat(flow)
	}
	return p
}

// The reason TWRR exists: a contribution must not read as a gain.
func TestTWRRIgnoresContributions(t *testing.T) {
	// 100 in, nothing moves, another 100 in, still nothing moves.
	got := TWRR([]SeriesPoint{
		pt("2026-01-01", "100", "100"),
		pt("2026-01-02", "100", ""),
		pt("2026-01-03", "200", "100"), // doubled in value, purely from the deposit
		pt("2026-01-04", "200", ""),
	})
	if len(got) != 4 {
		t.Fatalf("want 4 points, got %d", len(got))
	}
	for _, p := range got {
		if p.Index != "100.00" {
			t.Errorf("%s: index %s, want 100.00 — a deposit was counted as a gain",
				p.Date, p.Index)
		}
	}
}

// A real gain must survive a same-day contribution.
func TestTWRRSeparatesGainFromFlow(t *testing.T) {
	// Day 2: value goes 100 -> 210, of which 100 was deposited. The market did
	// 100 -> 110, i.e. +10%.
	got := TWRR([]SeriesPoint{
		pt("2026-01-01", "100", "100"),
		pt("2026-01-02", "210", "100"),
	})
	if got[1].Index != "110.00" {
		t.Errorf("index %s, want 110.00 (+10%% market, deposit excluded)", got[1].Index)
	}
}

// Chaining: two consecutive +10% days compound to +21%, not +20%.
func TestTWRRCompounds(t *testing.T) {
	got := TWRR([]SeriesPoint{
		pt("2026-01-01", "100", "100"),
		pt("2026-01-02", "110", ""),
		pt("2026-01-03", "121", ""),
	})
	if got[2].Index != "121.00" {
		t.Errorf("index %s, want 121.00", got[2].Index)
	}
}

// A withdrawal is a negative flow and must not read as a loss.
func TestTWRRIgnoresWithdrawals(t *testing.T) {
	got := TWRR([]SeriesPoint{
		pt("2026-01-01", "200", "200"),
		pt("2026-01-02", "100", "-100"), // took half out; market did nothing
	})
	if got[1].Index != "100.00" {
		t.Errorf("index %s, want 100.00 — a withdrawal was counted as a loss", got[1].Index)
	}
}

// Nothing is indexed before the position exists: a fund bought in 2024 has no
// 2022 performance, and drawing it from 100 would claim otherwise.
func TestTWRRSkipsLeadingEmptyDays(t *testing.T) {
	got := TWRR([]SeriesPoint{
		pt("2026-01-01", "0", ""),
		pt("2026-01-02", "0", ""),
		pt("2026-01-03", "100", "100"),
		pt("2026-01-04", "110", ""),
	})
	if len(got) != 2 {
		t.Fatalf("want 2 points (position began on the 3rd), got %d", len(got))
	}
	if got[0].Date != "2026-01-03" {
		t.Errorf("series starts %s, want 2026-01-03", got[0].Date)
	}
	if got[1].Index != "110.00" {
		t.Errorf("index %s, want 110.00", got[1].Index)
	}
}

// The identity that matters against a benchmark: with no flows at all, TWRR is
// just the price relative. An index series must reproduce itself exactly.
func TestTWRRMatchesPriceRelativeWithNoFlows(t *testing.T) {
	levels := []string{"20000", "21000", "19500", "22000", "24000"}
	pts := make([]SeriesPoint, len(levels))
	for i, l := range levels {
		pts[i] = SeriesPoint{Date: day(dayOf(i)), Value: mustRat(l)}
	}
	got := TWRR(pts)
	// 24000/20000 = 1.20 -> index 120
	if got[len(got)-1].Index != "120.00" {
		t.Errorf("index %s, want 120.00 (24000/20000)", got[len(got)-1].Index)
	}
}

func dayOf(i int) string {
	return []string{"2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"}[i]
}

func TestCAGRAnnualises(t *testing.T) {
	// Doubling over two years is 2^(1/2)-1 = 41.42%.
	if got := CAGR("100", "200", 730); got != "41.42" {
		t.Errorf("CAGR = %s, want 41.42", got)
	}
	// Under a month, annualising is arithmetic noise dressed as insight.
	if got := CAGR("100", "105", 20); got != "" {
		t.Errorf("CAGR over 20 days = %s, want empty", got)
	}
}

// A position closed to zero stops having a return rather than flatlining,
// which would imply it was still held.
func TestTWRRStopsAtZero(t *testing.T) {
	got := TWRR([]SeriesPoint{
		pt("2026-01-01", "100", "100"),
		pt("2026-01-02", "120", ""),
		pt("2026-01-03", "0", "-120"), // sold out
		pt("2026-01-04", "0", ""),
	})
	last := got[len(got)-1]
	if last.Date != "2026-01-03" {
		t.Errorf("series ends %s, want 2026-01-03 — it should not extend past the exit", last.Date)
	}
	if last.Index != "120.00" {
		t.Errorf("final index %s, want 120.00 — the gain up to the exit is kept", last.Index)
	}
}

func TestTWRREmpty(t *testing.T) {
	if got := TWRR(nil); len(got) != 0 {
		t.Errorf("want no points, got %d", len(got))
	}
	if s := SummariseSeries("k", "l", "sleeve", nil); s != nil {
		t.Errorf("want nil summary for an empty series, got %+v", s)
	}
}

var _ = big.NewRat
