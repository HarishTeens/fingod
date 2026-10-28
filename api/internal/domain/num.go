package domain

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Num is a decimal number kept as its literal text, never as a float.
//
// Money in fingod is exact: every arithmetic operation happens in Postgres
// NUMERIC, and Go only ever carries the digits between JSON and SQL. Parsing a
// rupee figure into a float64 on the way through would quietly round it, and
// the holdings_value_consistent CHECK exists precisely to catch that class of
// drift — so the type system should make it impossible in the first place.
//
// JSON accepts either a bare number or a quoted string; both round-trip back
// out as a bare number so the UI and the /refresh skill see ordinary JSON.
type Num string

var numPattern = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$`)

func (n *Num) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "null" {
		*n = ""
		return nil
	}
	if len(s) >= 2 && s[0] == '"' {
		var str string
		if err := json.Unmarshal(b, &str); err != nil {
			return err
		}
		s = strings.TrimSpace(str)
	}
	if !numPattern.MatchString(s) {
		return fmt.Errorf("%q is not a decimal number", s)
	}
	*n = Num(s)
	return nil
}

// MarshalJSON emits the digits verbatim as a JSON number. json.RawMessage-style
// passthrough keeps trailing zeros ("100000.00" stays two-dp) which a float
// would drop.
func (n Num) MarshalJSON() ([]byte, error) {
	if n == "" {
		return []byte("null"), nil
	}
	return []byte(n), nil
}

func (n Num) Empty() bool { return n == "" }

func (n Num) String() string { return string(n) }

// Or returns a fallback when the value is absent, for defaults like fx_rate 1.
func (n Num) Or(fallback string) Num {
	if n == "" {
		return Num(fallback)
	}
	return n
}
