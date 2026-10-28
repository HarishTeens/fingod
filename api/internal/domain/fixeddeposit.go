package domain

import "strings"

// FixedDeposit is a standing row, deliberately not snapshotted per checkpoint.
// Principal, rate and start date are enough to value it at any past or future
// date, so an FD entered today values correctly at checkpoints taken before it
// was entered.
type FixedDeposit struct {
	ID           int64  `json:"id"`
	Bank         string `json:"bank"`
	Principal    Num    `json:"principal"`
	RatePct      Num    `json:"rate_pct"`
	StartDate    Date   `json:"start_date"`
	MaturityDate Date   `json:"maturity_date"`
	ClosedAt     *Date  `json:"closed_at,omitempty"`
	Compounding  string `json:"compounding,omitempty"`
	Note         string `json:"note,omitempty"`
}

// Compounding modes. Quarterly is the Indian bank convention and the default.
const (
	CompoundQuarterly = "quarterly"
	CompoundSimple    = "simple"
)

// SplitwiseBalance is one person's bottom line. Splitwise stays the system of
// record for the individual expenses; fingod carries only the net figure.
type SplitwiseBalance struct {
	Person    string `json:"person"`
	AmountINR Num    `json:"amount_inr"` // positive = they owe you
	Note      string `json:"note,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

// Validate checks an FD can be stored and fills in the compounding default.
func (fd *FixedDeposit) Validate() error {
	if strings.TrimSpace(fd.Bank) == "" {
		return invalid("bank is required")
	}
	if fd.Principal.Empty() {
		return invalid("principal is required")
	}
	if strings.HasPrefix(fd.Principal.String(), "-") || fd.Principal == "0" {
		return invalid("principal must be positive, got %s", fd.Principal)
	}
	if fd.RatePct.Empty() {
		return invalid("rate_pct is required — without it no interest can be computed and NW_total understates")
	}
	if strings.HasPrefix(fd.RatePct.String(), "-") {
		return invalid("rate_pct must not be negative, got %s", fd.RatePct)
	}
	if fd.StartDate.IsZero() {
		return invalid("start_date is required (YYYY-MM-DD)")
	}
	if fd.MaturityDate.IsZero() {
		return invalid("maturity_date is required (YYYY-MM-DD)")
	}
	if !fd.MaturityDate.Time.After(fd.StartDate.Time) {
		return invalid("maturity_date %s must be after start_date %s", fd.MaturityDate, fd.StartDate)
	}
	if fd.ClosedAt != nil && fd.ClosedAt.Time.Before(fd.StartDate.Time) {
		return invalid("closed_at %s is before start_date %s", fd.ClosedAt, fd.StartDate)
	}
	switch fd.Compounding {
	case "":
		fd.Compounding = CompoundQuarterly
	case CompoundQuarterly, CompoundSimple:
	default:
		return invalid("compounding must be %q or %q, got %q", CompoundQuarterly, CompoundSimple, fd.Compounding)
	}
	return nil
}

// Validate checks a person's balance. A zero is allowed and meaningful: it
// records that you have settled up, rather than deleting the person and losing
// them from the next checkpoint.
func (sb *SplitwiseBalance) Validate() error {
	sb.Person = strings.TrimSpace(sb.Person)
	if sb.Person == "" {
		return invalid("person is required")
	}
	if sb.AmountINR.Empty() {
		return invalid("amount_inr is required — positive if %s owes you, negative if you owe them", sb.Person)
	}
	return nil
}
