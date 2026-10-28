package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func fd(t *testing.T) FixedDeposit {
	t.Helper()
	start, _ := ParseDate("2026-01-01")
	maturity, _ := ParseDate("2027-01-01")
	return FixedDeposit{Bank: "Example Bank", Principal: "200000", RatePct: "6.25",
		StartDate: start, MaturityDate: maturity}
}

func TestFDDefaultsToQuarterly(t *testing.T) {
	d := fd(t)
	if err := d.Validate(); err != nil {
		t.Fatal(err)
	}
	if d.Compounding != CompoundQuarterly {
		t.Errorf("compounding defaulted to %q, want the Indian bank convention", d.Compounding)
	}
}

func TestFDRequiresARate(t *testing.T) {
	// Principal alone is the failure mode this guards: it values the deposit at
	// par forever and silently understates NW_total by the accrued interest.
	d := fd(t)
	d.RatePct = ""
	err := d.Validate()
	if err == nil || !strings.Contains(err.Error(), "rate_pct") {
		t.Errorf("FD without a rate gave %v", err)
	}
}

func TestFDRejectsImpossibleDates(t *testing.T) {
	d := fd(t)
	d.MaturityDate = d.StartDate
	if err := d.Validate(); err == nil {
		t.Error("maturity on the start date was accepted")
	}

	d = fd(t)
	before, _ := ParseDate("2025-06-01")
	d.ClosedAt = &before
	if err := d.Validate(); err == nil {
		t.Error("a deposit closed before it started was accepted")
	}
}

func TestFDRejectsNonsenseAmounts(t *testing.T) {
	for _, tc := range []struct{ name, principal, rate string }{
		{"zero principal", "0", "6.25"},
		{"negative principal", "-100", "6.25"},
		{"negative rate", "200000", "-1"},
	} {
		d := fd(t)
		d.Principal, d.RatePct = Num(tc.principal), Num(tc.rate)
		if err := d.Validate(); err == nil {
			t.Errorf("%s was accepted", tc.name)
		}
	}
}

func TestSplitwiseSignConvention(t *testing.T) {
	// Both directions are legitimate: a receivable and a debt are the same
	// column with a sign, and zero records "settled up" without dropping the
	// person from the next checkpoint.
	for _, amount := range []Num{"3200", "-450", "0"} {
		b := SplitwiseBalance{Person: "Ravi", AmountINR: amount}
		if err := b.Validate(); err != nil {
			t.Errorf("amount %s rejected: %v", amount, err)
		}
	}
}

func TestSplitwiseNeedsAPersonAndAnAmount(t *testing.T) {
	b := SplitwiseBalance{Person: "   ", AmountINR: "100"}
	if err := b.Validate(); err == nil {
		t.Error("a blank person was accepted")
	}
	b = SplitwiseBalance{Person: "Ravi"}
	if err := b.Validate(); err == nil {
		t.Error("a person with no amount was accepted")
	}
}

func TestSplitwiseIsNotAcceptedOnACheckpoint(t *testing.T) {
	// One source per figure. Splitwise is a standing list snapshotted at
	// checkpoint time, so a payload carrying it would be a second source for
	// the same number.
	const payload = `{"as_of_date":"2026-09-05","usd_inr":94.485,
	  "balances":[{"kind":"splitwise","ref":"Ravi","amount_inr":3200}]}`
	var in CheckpointInput
	if err := json.Unmarshal([]byte(payload), &in); err != nil {
		t.Fatal(err)
	}
	err := in.Validate()
	if err == nil || !strings.Contains(err.Error(), "standing rows") {
		t.Errorf("splitwise on a checkpoint gave %v", err)
	}
}
