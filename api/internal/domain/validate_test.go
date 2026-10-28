package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func base() *CheckpointInput {
	return &CheckpointInput{
		AsOfDate: mustDate("2026-09-05"),
		USDINR:   "94.485",
		Sources:  map[string]string{"indmoney": "ok"},
	}
}

func mustDate(s string) Date {
	d, err := ParseDate(s)
	if err != nil {
		panic(err)
	}
	return d
}

func TestValidateDefaultsFXFromTheCheckpointRate(t *testing.T) {
	// A USD holding with no explicit rate must inherit the checkpoint's own
	// usd_inr, so value_inr can never be computed against a rate the
	// checkpoint does not record.
	in := base()
	in.Holdings = []Holding{{Sleeve: SleeveUSEquity, Symbol: "ACME", Qty: "2.01291325", Price: "500.00", Currency: "usd"}}
	if err := in.Validate(); err != nil {
		t.Fatal(err)
	}
	if got := in.Holdings[0].FXRate; got != "94.485" {
		t.Errorf("fx_rate defaulted to %q, want the checkpoint rate", got)
	}
	if got := in.Holdings[0].Currency; got != "USD" {
		t.Errorf("currency normalised to %q", got)
	}
}

func TestValidateINRHoldingsAreRateOne(t *testing.T) {
	in := base()
	in.Holdings = []Holding{{Sleeve: SleeveINEquity, Symbol: "ALPHA", Qty: "100", Price: "200.00"}}
	if err := in.Validate(); err != nil {
		t.Fatal(err)
	}
	if in.Holdings[0].FXRate != "1" {
		t.Errorf("INR holding got fx_rate %q", in.Holdings[0].FXRate)
	}

	in = base()
	in.Holdings = []Holding{{Sleeve: SleeveINEquity, Symbol: "ALPHA", Qty: "100", Price: "200.00", Currency: "INR", FXRate: "94.485"}}
	if err := in.Validate(); err == nil {
		t.Error("an INR holding with a non-1 fx_rate was accepted")
	}
}

func TestValidateRequiresQuantity(t *testing.T) {
	// INDmoney's CRYPTO row is exactly this shape: a value with no units. It
	// cannot enter holdings, because the qty-diff engine could not attribute it.
	in := base()
	in.Holdings = []Holding{{Sleeve: SleeveBTC, Symbol: "BTC", Price: "97175.94"}}
	err := in.Validate()
	if err == nil || !strings.Contains(err.Error(), "qty") {
		t.Errorf("qty-less holding gave %v", err)
	}
}

func TestValidateRejectsDuplicates(t *testing.T) {
	in := base()
	in.Holdings = []Holding{
		{Sleeve: SleeveINEquity, Symbol: "ACME", Qty: "50", Price: "100.00"},
		{Sleeve: SleeveINEquity, Symbol: "ACME", Qty: "10", Price: "100.00"},
	}
	if err := in.Validate(); err == nil {
		t.Error("duplicate symbol accepted — the UNIQUE would have failed mid-transaction instead")
	}

	in = base()
	in.Balances = []Balance{
		{Kind: KindEPF, Ref: "Employer Two", AmountINR: "50000"},
		{Kind: KindEPF, Ref: "Employer Two", AmountINR: "1"},
	}
	if err := in.Validate(); err == nil {
		t.Error("duplicate balance ref accepted")
	}
}

func TestValidateCreditCardSignConvention(t *testing.T) {
	// Wallet reports a card owing money as a negative balance; the schema
	// stores it positive. A negative here means the caller forgot to flip it.
	in := base()
	in.Balances = []Balance{{Kind: KindCreditCard, Ref: "Card A", AmountINR: "-5000.00"}}
	if err := in.Validate(); err == nil {
		t.Error("negative credit-card outstanding accepted")
	}
}

func TestValidateSourceStates(t *testing.T) {
	in := base()
	in.Sources = map[string]string{"kite": "down"}
	if err := in.Validate(); err == nil {
		t.Error(`sources value "down" accepted; only ok/stale are meaningful`)
	}
}

func TestValidateRejectsMissingRate(t *testing.T) {
	in := base()
	in.USDINR = ""
	if err := in.Validate(); err == nil {
		t.Error("checkpoint without usd_inr accepted")
	}
}

func TestCheckpointInputDecodesTheRefreshPayload(t *testing.T) {
	// The shape docs/MCP-SHAPES.md says /refresh will send, decoded end to end.
	const payload = `{
	  "as_of_date": "2026-09-05",
	  "usd_inr": 90,
	  "sources": {"wallet":"ok","kite":"stale","indmoney":"ok"},
	  "holdings": [
	    {"sleeve":"us_equity","symbol":"ACME","name":"Acme Corp",
	     "qty":2,"price":500,"currency":"USD","value_inr":90000}
	  ],
	  "balances": [
	    {"kind":"epf","ref":"Employer One","amount_inr":100000}
	  ],
	  "wallet_accounts": [
	    {"id":"00000000","name":"Term Deposit","account_type":"General"}
	  ]
	}`
	var in CheckpointInput
	if err := json.Unmarshal([]byte(payload), &in); err != nil {
		t.Fatal(err)
	}
	if err := in.Validate(); err != nil {
		t.Fatal(err)
	}
	if in.Holdings[0].Qty != "2" {
		t.Errorf("qty lost precision: %q", in.Holdings[0].Qty)
	}
	if in.WalletAccounts[0].Currency != "INR" {
		t.Errorf("account currency defaulted to %q", in.WalletAccounts[0].Currency)
	}
}
