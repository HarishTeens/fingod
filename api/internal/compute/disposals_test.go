package compute

import (
	"testing"

	"github.com/harishteens/fingod/api/internal/domain"
)

func pos(symbol, isin, qty, price, invested string) domain.Holding {
	return domain.Holding{
		Sleeve: "in_equity", Symbol: symbol, ISIN: isin,
		Qty: domain.Num(qty), Price: domain.Num(price), FXRate: "1", Currency: "INR",
		InvestedINR: domain.Num(invested),
	}
}

func TestFullExitIsDetected(t *testing.T) {
	prev := []domain.Holding{pos("ACME", "INE000A01001", "400", "120.00", "40000.00")}
	ds, err := FindDisposals(prev, nil, "2026-09-05", "2026-09-12")
	if err != nil {
		t.Fatal(err)
	}
	if len(ds) != 1 {
		t.Fatalf("got %d disposals", len(ds))
	}
	d := ds[0]
	if !d.FullExit {
		t.Error("not marked as a full exit")
	}
	if d.EstimatedProceeds != "48000.00" {
		t.Errorf("proceeds = %s, want 400 x 120.00", d.EstimatedProceeds)
	}
	if d.EstimatedRealised != "8000.00" {
		t.Errorf("realised = %s, want proceeds less the 40000.00 cost", d.EstimatedRealised)
	}
}

func TestPartialSaleUsesAverageCost(t *testing.T) {
	// Half the position out: half the cost basis goes with it, which is what
	// every broker does and the only split that leaves the remainder coherent.
	prev := []domain.Holding{pos("ACME", "INE000A01001", "400", "120.00", "40000.00")}
	now := []domain.Holding{pos("ACME", "INE000A01001", "100", "120.00", "10000.00")}
	ds, err := FindDisposals(prev, now, "a", "b")
	if err != nil {
		t.Fatal(err)
	}
	d := ds[0]
	if d.FullExit {
		t.Error("a partial sale was marked a full exit")
	}
	if d.InvestedSold != "30000.00" {
		t.Errorf("cost of shares sold = %s, want 30000.00", d.InvestedSold)
	}
	if d.EstimatedRealised != "6000.00" {
		t.Errorf("realised = %s, want 300 x 120 less 30000", d.EstimatedRealised)
	}
}

func TestBuyingMoreIsNotADisposal(t *testing.T) {
	prev := []domain.Holding{pos("ACME", "INE000A01001", "100", "120.00", "10000.00")}
	now := []domain.Holding{pos("ACME", "INE000A01001", "400", "120.00", "40000.00")}
	ds, err := FindDisposals(prev, now, "a", "b")
	if err != nil {
		t.Fatal(err)
	}
	if len(ds) != 0 {
		t.Errorf("adding to a position reported %d disposals", len(ds))
	}
}

func TestRenameIsNotASale(t *testing.T) {
	// OLDNAME became NEWNAME. Matched on ticker this reads as selling the whole
	// position — and would invent a realised loss for all of it.
	prev := []domain.Holding{pos("OLDNAME", "INE000B01002", "50", "400", "20000.00")}
	now := []domain.Holding{pos("NEWNAME", "INE000B01002", "50", "300", "20000.00")}
	ds, err := FindDisposals(prev, now, "a", "b")
	if err != nil {
		t.Fatal(err)
	}
	if len(ds) != 0 {
		t.Errorf("a rename was reported as %d disposals", len(ds))
	}
}

func TestUSDDisposalConvertsAtTheCheckpointRate(t *testing.T) {
	h := domain.Holding{
		Sleeve: "us_equity", Symbol: "ACME", Qty: "2", Price: "500.00",
		FXRate: "90", Currency: "USD", InvestedINR: "80000.00",
	}
	ds, err := FindDisposals([]domain.Holding{h}, nil, "a", "b")
	if err != nil {
		t.Fatal(err)
	}
	// 2 x 500 x 90 — proceeds in rupees, not dollars.
	if ds[0].EstimatedProceeds != "90000.00" {
		t.Errorf("proceeds = %s, want 90000.00", ds[0].EstimatedProceeds)
	}
}
