package compute

import (
	"testing"

	"github.com/harishteens/fingod/api/internal/domain"
)

func date(t *testing.T, s string) domain.Date {
	t.Helper()
	d, err := domain.ParseDate(s)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// A sample deposit: ₹1,00,000 at 7.1% over 2025-09-05 → 2027-09-05.
func sampleFD(t *testing.T) domain.FixedDeposit {
	return domain.FixedDeposit{
		Bank:         "Example Bank",
		Principal:    "100000",
		RatePct:      "7.1",
		StartDate:    date(t, "2025-09-05"),
		MaturityDate: date(t, "2027-09-05"),
		Compounding:  CompoundQuarterly,
	}
}

// TestAgainstABankCalculator checks the arithmetic against the figures an
// online FD calculator gives for the same principal, rate and tenure — the
// verification step the plan asks for by name.
func TestAgainstABankCalculator(t *testing.T) {
	fd := sampleFD(t)

	cases := []struct {
		at   string
		want domain.Num
	}{
		{"2026-09-05", "7291.28"}, // exactly one year, 7.2913% effective
		{"2027-09-05", "15114.20"},
		{"2026-03-05", "3551.55"}, // 181 days, 0.49589 years
	}
	for _, tc := range cases {
		got, err := Accrued(fd, date(t, tc.at))
		if err != nil {
			t.Fatal(err)
		}
		if got != tc.want {
			t.Errorf("accrued at %s = %s, want %s", tc.at, got, tc.want)
		}
	}
}

func TestQuarterlyBeatsSimple(t *testing.T) {
	fd := sampleFD(t)
	quarterly, err := Accrued(fd, date(t, "2026-09-05"))
	if err != nil {
		t.Fatal(err)
	}
	fd.Compounding = CompoundSimple
	simple, err := Accrued(fd, date(t, "2026-09-05"))
	if err != nil {
		t.Fatal(err)
	}
	if simple != "7100.00" {
		t.Errorf("simple interest = %s, want 7100.00 (100000 x 7.1%%)", simple)
	}
	if mustRat(quarterly.String()).Cmp(mustRat(simple.String())) <= 0 {
		t.Errorf("quarterly %s should exceed simple %s", quarterly, simple)
	}
}

func TestInterestStopsAtMaturity(t *testing.T) {
	fd := sampleFD(t)
	atMaturity, err := Accrued(fd, date(t, "2027-09-05"))
	if err != nil {
		t.Fatal(err)
	}
	longAfter, err := Accrued(fd, date(t, "2035-01-01"))
	if err != nil {
		t.Fatal(err)
	}
	if atMaturity != longAfter {
		t.Errorf("a matured deposit kept accruing: %s at maturity, %s eight years later", atMaturity, longAfter)
	}
}

func TestValuesCorrectlyBeforeItWasEntered(t *testing.T) {
	// The point of storing FDs as standing rows: an FD added today must value
	// correctly at checkpoints taken before it existed in the database.
	fd := sampleFD(t)

	before, err := Value(fd, date(t, "2025-01-01"))
	if err != nil {
		t.Fatal(err)
	}
	if before != "0.00" {
		t.Errorf("value before the start date = %s, want 0.00", before)
	}

	atStart, err := Value(fd, date(t, "2025-09-05"))
	if err != nil {
		t.Fatal(err)
	}
	if atStart != "100000.00" {
		t.Errorf("value on day one = %s, want the bare principal", atStart)
	}

	later, err := Value(fd, date(t, "2026-09-05"))
	if err != nil {
		t.Fatal(err)
	}
	if later != "107291.28" {
		t.Errorf("value after a year = %s, want 107291.28", later)
	}
}

func TestClosedDepositDropsOut(t *testing.T) {
	fd := sampleFD(t)
	closed := date(t, "2026-03-05")
	fd.ClosedAt = &closed

	// Before closure it is worth principal plus interest to that day.
	during, err := Value(fd, date(t, "2026-01-01"))
	if err != nil {
		t.Fatal(err)
	}
	if during == "0.00" {
		t.Error("a running deposit valued at zero")
	}

	// On and after closure it contributes nothing — the money is now cash,
	// counted once, somewhere else.
	after, err := Value(fd, date(t, "2026-06-01"))
	if err != nil {
		t.Fatal(err)
	}
	if after != "0.00" {
		t.Errorf("closed deposit still worth %s", after)
	}

	// And its interest stopped on the closing date.
	atClose, err := Accrued(fd, closed)
	if err != nil {
		t.Fatal(err)
	}
	muchLater, err := Accrued(fd, date(t, "2027-01-01"))
	if err != nil {
		t.Fatal(err)
	}
	if atClose != muchLater {
		t.Errorf("interest kept running after closure: %s vs %s", atClose, muchLater)
	}
}
