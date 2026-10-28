package domain

import (
	"encoding/json"
	"fmt"
	"time"
)

// DateLayout is the only date format fingod speaks on the wire.
const DateLayout = "2006-01-02"

// Date is a calendar day with no time and no zone.
//
// A checkpoint's as_of_date is a day, not an instant: "2026-09-05" from Mumbai
// and from UTC must be the same row, or the UNIQUE constraint that makes ingest
// idempotent stops meaning anything. time.Time would drag a zone along and let
// a late-evening IST refresh land on the previous UTC day.
type Date struct{ time.Time }

func NewDate(t time.Time) Date {
	y, m, d := t.Date()
	return Date{time.Date(y, m, d, 0, 0, 0, 0, time.UTC)}
}

func ParseDate(s string) (Date, error) {
	t, err := time.Parse(DateLayout, s)
	if err != nil {
		return Date{}, fmt.Errorf("date must be YYYY-MM-DD, got %q", s)
	}
	return Date{t}, nil
}

func (d *Date) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("date must be a YYYY-MM-DD string")
	}
	parsed, err := ParseDate(s)
	if err != nil {
		return err
	}
	*d = parsed
	return nil
}

func (d Date) MarshalJSON() ([]byte, error) { return json.Marshal(d.String()) }

func (d Date) String() string { return d.Time.Format(DateLayout) }

func (d Date) IsZero() bool { return d.Time.IsZero() }
