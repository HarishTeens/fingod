package domain

import (
	"encoding/json"
	"testing"
)

func TestNumKeepsExactDigits(t *testing.T) {
	// The point of Num: a float64 round-trip would turn 12345.67 into
	// 12345.670000000001 and drop the trailing zero from 100000.00.
	for _, in := range []string{"12345.67", "100000.00", "2.01291325", "-500", "0", "90.000000"} {
		var n Num
		if err := json.Unmarshal([]byte(in), &n); err != nil {
			t.Fatalf("unmarshal %s: %v", in, err)
		}
		if n.String() != in {
			t.Errorf("Num(%s) became %s", in, n)
		}
		out, err := json.Marshal(n)
		if err != nil {
			t.Fatal(err)
		}
		if string(out) != in {
			t.Errorf("marshal %s produced %s", in, out)
		}
	}
}

func TestNumAcceptsQuotedAndNull(t *testing.T) {
	var n Num
	if err := json.Unmarshal([]byte(`"1234.5678"`), &n); err != nil {
		t.Fatal(err)
	}
	if n != "1234.5678" {
		t.Errorf("quoted form gave %q", n)
	}
	if err := json.Unmarshal([]byte(`null`), &n); err != nil {
		t.Fatal(err)
	}
	if !n.Empty() {
		t.Errorf("null should give an empty Num, got %q", n)
	}
	out, _ := json.Marshal(Num(""))
	if string(out) != "null" {
		t.Errorf("empty Num marshalled as %s", out)
	}
}

func TestNumRejectsJunk(t *testing.T) {
	// Anything that is not a plain decimal must fail loudly rather than reach
	// SQL, where "1,00,000" or "₹500" would be a runtime cast error at best.
	for _, bad := range []string{`"1,00,000"`, `"₹500"`, `"abc"`, `""`, `"1.2.3"`, `"+5"`, `" "`} {
		var n Num
		if err := json.Unmarshal([]byte(bad), &n); err == nil {
			t.Errorf("%s was accepted as %q", bad, n)
		}
	}
}

func TestNumOr(t *testing.T) {
	if got := Num("").Or("1"); got != "1" {
		t.Errorf("empty Or(1) = %q", got)
	}
	if got := Num("94.485").Or("1"); got != "94.485" {
		t.Errorf("set Or(1) = %q", got)
	}
}

func TestDateIsZonefree(t *testing.T) {
	var d Date
	if err := json.Unmarshal([]byte(`"2026-09-05"`), &d); err != nil {
		t.Fatal(err)
	}
	if d.String() != "2026-09-05" {
		t.Errorf("round-tripped to %s", d)
	}
	if err := json.Unmarshal([]byte(`"05-09-2026"`), &d); err == nil {
		t.Error("accepted a non-ISO date")
	}
	if err := json.Unmarshal([]byte(`"2026-09-05T22:30:00+05:30"`), &d); err == nil {
		t.Error("accepted a timestamp: a checkpoint is a day, not an instant")
	}
}
