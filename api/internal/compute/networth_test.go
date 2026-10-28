package compute

import (
	"testing"

	"github.com/harishteens/fingod/api/internal/domain"
)

// A synthetic checkpoint dated 2026-09-05, with the sleeves carved the way the
// ingest will carve them.
func sampleCheckpoint(t *testing.T) NetWorthInput {
	t.Helper()
	return NetWorthInput{
		AsOf: date(t, "2026-09-05"),
		Holdings: []Position{
			{Sleeve: domain.SleeveINEquity, Symbol: "ALPHA", ISIN: "INE000A01001", Qty: "100", Price: "200.00", FXRate: "1"},
			{Sleeve: domain.SleeveINEquity, Symbol: "BETA", ISIN: "INE000B01002", Qty: "50", Price: "100.00", FXRate: "1"},
			{Sleeve: domain.SleeveGold, Symbol: "GOLDETF", ISIN: "INF000G01001", Qty: "200", Price: "100.00", FXRate: "1"},
			{Sleeve: domain.SleeveINEquity, Symbol: "LIQUIDETF", ISIN: "INF000L01001", Qty: "100", Price: "100.00", FXRate: "1"},
			{Sleeve: domain.SleeveINMF, Symbol: "INF000F01001", ISIN: "INF000F01001", Qty: "1000.5", Price: "50.00", FXRate: "1"},
			{Sleeve: domain.SleeveUSEquity, Symbol: "ACME", Qty: "2", Price: "500.00", FXRate: "90", Currency: "USD"},
			{Sleeve: domain.SleeveBTC, Symbol: "BTC", Qty: "0.1", Price: "1000000", FXRate: "1"},
		},
		Balances: []domain.Balance{
			{Kind: domain.KindCash, Ref: "Bank A", AmountINR: "10000.00"},
			{Kind: domain.KindCash, Ref: "Bank B", AmountINR: "5000.00"},
			{Kind: domain.KindCash, Ref: "Cash", AmountINR: "100"},
			{Kind: domain.KindCash, Ref: "Wallet balance", AmountINR: "50"},
			{Kind: domain.KindCreditCard, Ref: "Card A", AmountINR: "5000.00"},
			{Kind: domain.KindCreditCard, Ref: "Card B", AmountINR: "1000.50"},
			{Kind: domain.KindCreditCard, Ref: "Card C", AmountINR: "0.25"},
			{Kind: domain.KindEPF, Ref: "Employer One", AmountINR: "100000"},
			{Kind: domain.KindEPF, Ref: "Employer Two", AmountINR: "50000"},
			{Kind: domain.KindSplitwise, Ref: "Friend A", AmountINR: "3000"},
			{Kind: domain.KindSplitwise, Ref: "Friend B", AmountINR: "-500"},
		},
		FixedDeposits: []domain.FixedDeposit{sampleFD(t)},
	}
}

// TestTheTwoFiguresDifferByExactlyTheIlliquidPart is the plan's arithmetic
// check: whatever else changes, total minus liquid must be EPF plus accrued FD
// interest plus receivables, and nothing else.
func TestTheTwoFiguresDifferByExactlyTheIlliquidPart(t *testing.T) {
	nw, err := Compute(sampleCheckpoint(t))
	if err != nil {
		t.Fatal(err)
	}

	gap := sub(mustRat(nw.Total.String()), mustRat(nw.Liquid.String()))
	want := add(
		mustRat(nw.EPF.String()),
		mustRat(nw.FDAccrued.String()),
		mustRat(nw.Splitwise.String()),
	)
	if gap.Cmp(want) != 0 {
		t.Errorf("total - liquid = %s, want epf + fd accrued + splitwise = %s",
			gap.FloatString(2), want.FloatString(2))
	}
}

// TestLiquidReconcilesByHand recomputes the figure from its parts the long way.
func TestLiquidReconcilesByHand(t *testing.T) {
	nw, err := Compute(sampleCheckpoint(t))
	if err != nil {
		t.Fatal(err)
	}

	byHand := sub(
		add(
			mustRat(nw.Investments.String()),
			mustRat(nw.Cash.String()),
			mustRat(nw.FDPrincipal.String()),
		),
		mustRat(nw.CreditCard.String()),
	)
	if byHand.Cmp(mustRat(nw.Liquid.String())) != 0 {
		t.Errorf("liquid = %s, hand-computed %s", nw.Liquid, byHand.FloatString(2))
	}

	// And the sleeves must account for all of the investment total.
	sum := mustRat("0")
	for _, name := range nw.SleeveNames() {
		sum.Add(sum, mustRat(nw.Sleeves[name].String()))
	}
	if sum.Cmp(mustRat(nw.Investments.String())) != 0 {
		t.Errorf("sleeves sum to %s, investments = %s", sum.FloatString(2), nw.Investments)
	}
}

func TestCreditCardIsSubtractedNotAdded(t *testing.T) {
	in := sampleCheckpoint(t)
	before, err := Compute(in)
	if err != nil {
		t.Fatal(err)
	}

	in.Balances = append(in.Balances, domain.Balance{
		Kind: domain.KindCreditCard, Ref: "New card", AmountINR: "10000",
	})
	after, err := Compute(in)
	if err != nil {
		t.Fatal(err)
	}

	diff := sub(mustRat(after.Liquid.String()), mustRat(before.Liquid.String()))
	if diff.Cmp(mustRat("-10000")) != 0 {
		t.Errorf("owing another ₹10,000 changed net worth by %s, want -10000", diff.FloatString(2))
	}
}

func TestUSHoldingsAreConvertedNotAdded(t *testing.T) {
	// ACME: 2 x 500 x 90. If the USD figure were added raw the sleeve would
	// read ₹1,000 instead of ₹90,000.
	nw, err := Compute(sampleCheckpoint(t))
	if err != nil {
		t.Fatal(err)
	}
	if got := nw.Sleeves[domain.SleeveUSEquity]; got != "90000.00" {
		t.Errorf("us_equity = %s, want 90000.00 (2 x 500 x 90)", got)
	}
}

func TestGoldIsNotEquityButOvernightETFsAre(t *testing.T) {
	nw, err := Compute(sampleCheckpoint(t))
	if err != nil {
		t.Fatal(err)
	}
	if nw.Sleeves[domain.SleeveGold] != "20000.00" {
		t.Errorf("gold = %s, want 20000.00 — Kite delivers it as equity, it is not", nw.Sleeves[domain.SleeveGold])
	}
	if _, present := nw.Sleeves[domain.SleeveGold+"_liquid"]; present {
		t.Error("a liquid sleeve reappeared")
	}
	// 100 x 200 + 50 x 100 + 100 x 100 = 20000 + 5000 + 10000
	if nw.Sleeves[domain.SleeveINEquity] != "35000.00" {
		t.Errorf("in_equity = %s, want 35000.00 — gold carved out, the liquid ETF folded back in",
			nw.Sleeves[domain.SleeveINEquity])
	}
}

func TestFDEnteredLaterStillValuesPastCheckpoints(t *testing.T) {
	// A checkpoint dated before the FD started must not count it at all.
	in := sampleCheckpoint(t)
	in.AsOf = date(t, "2025-01-01")
	nw, err := Compute(in)
	if err != nil {
		t.Fatal(err)
	}
	if nw.FDPrincipal != "0.00" || nw.FDAccrued != "0.00" {
		t.Errorf("FD counted before it existed: principal %s accrued %s", nw.FDPrincipal, nw.FDAccrued)
	}
}

func TestSplitwiseCanBeNegative(t *testing.T) {
	// Owing a friend money is a real liability and belongs in the total.
	nw, err := Compute(sampleCheckpoint(t))
	if err != nil {
		t.Fatal(err)
	}
	if nw.Splitwise != "2500.00" {
		t.Errorf("splitwise = %s, want 2500.00 (3000 owed to you, 500 by you)", nw.Splitwise)
	}
}
