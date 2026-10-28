package domain

import (
	"fmt"
	"slices"
	"strings"
)

// InvalidError is a caller error: the payload is malformed. The HTTP layer maps
// it to 400 and hands the message straight back, so messages name the offending
// field and value.
type InvalidError struct{ msg string }

func (e InvalidError) Error() string { return e.msg }

func invalid(format string, a ...any) error {
	return InvalidError{fmt.Sprintf(format, a...)}
}

// Validate checks the payload can be stored, filling in the defaults that the
// /refresh skill is allowed to omit. It does not compute value_inr — that is
// Postgres NUMERIC arithmetic, deliberately (see store.SaveCheckpoint).
func (in *CheckpointInput) Validate() error {
	if in.AsOfDate.IsZero() {
		return invalid("as_of_date is required (YYYY-MM-DD)")
	}
	if in.USDINR.Empty() {
		return invalid("usd_inr is required — the FX rate at this checkpoint, e.g. 94.485")
	}
	if strings.HasPrefix(in.USDINR.String(), "-") || in.USDINR == "0" {
		return invalid("usd_inr must be positive, got %s", in.USDINR)
	}
	if in.Sources == nil {
		in.Sources = map[string]string{}
	}
	for name, state := range in.Sources {
		if state != SourceOK && state != SourceStale {
			return invalid("sources.%s must be %q or %q, got %q", name, SourceOK, SourceStale, state)
		}
	}

	seenHolding := map[string]bool{}
	for i := range in.Holdings {
		h := &in.Holdings[i]
		if !slices.Contains(Sleeves, h.Sleeve) {
			return invalid("holdings[%d].sleeve must be one of %s, got %q", i, strings.Join(Sleeves, ", "), h.Sleeve)
		}
		if strings.TrimSpace(h.Symbol) == "" {
			return invalid("holdings[%d].symbol is required", i)
		}
		if h.Qty.Empty() {
			return invalid("holdings[%d] (%s) needs a qty — a value with no quantity cannot be attributed by the qty-diff engine", i, h.Symbol)
		}
		if h.Price.Empty() {
			return invalid("holdings[%d] (%s) needs a price", i, h.Symbol)
		}
		if h.Currency == "" {
			h.Currency = "INR"
		}
		h.Currency = strings.ToUpper(h.Currency)
		// A US holding priced in USD without an explicit rate uses the
		// checkpoint's own rate, so value_inr can never be computed against a
		// rate the checkpoint does not record.
		if h.FXRate.Empty() {
			switch h.Currency {
			case "INR":
				h.FXRate = "1"
			case "USD":
				h.FXRate = in.USDINR
			default:
				return invalid("holdings[%d] (%s) is priced in %s, so it needs an explicit fx_rate", i, h.Symbol, h.Currency)
			}
		}
		if h.Currency == "INR" && h.FXRate != "1" {
			return invalid("holdings[%d] (%s) is priced in INR so fx_rate must be 1, got %s", i, h.Symbol, h.FXRate)
		}
		key := h.Sleeve + "\x00" + h.Symbol
		if seenHolding[key] {
			return invalid("holdings contains %s/%s twice — merge the rows before posting", h.Sleeve, h.Symbol)
		}
		seenHolding[key] = true
	}

	seenBalance := map[string]bool{}
	for i := range in.Balances {
		b := &in.Balances[i]
		if !slices.Contains(BalanceKinds, b.Kind) {
			return invalid("balances[%d].kind must be one of %s, got %q", i, strings.Join(BalanceKinds, ", "), b.Kind)
		}
		if strings.TrimSpace(b.Ref) == "" {
			return invalid("balances[%d].ref is required (account name, employer or person)", i)
		}
		if b.AmountINR.Empty() {
			return invalid("balances[%d] (%s) needs an amount_inr", i, b.Ref)
		}
		if b.Kind == KindSplitwise {
			return invalid("balances[%d]: splitwise balances are not sent with a checkpoint — "+
				"they are standing rows, set via PUT /api/v1/splitwise/{person}, and snapshotted "+
				"automatically. Sending them here would give the same figure two sources", i)
		}
		if b.Kind == KindCreditCard && strings.HasPrefix(b.AmountINR.String(), "-") {
			return invalid("balances[%d] (%s): credit_card is stored positive as outstanding debt, got %s", i, b.Ref, b.AmountINR)
		}
		key := b.Kind + "\x00" + b.Ref
		if seenBalance[key] {
			return invalid("balances contains %s/%s twice — merge the rows before posting", b.Kind, b.Ref)
		}
		seenBalance[key] = true
	}

	for i := range in.WalletAccounts {
		a := &in.WalletAccounts[i]
		if strings.TrimSpace(a.ID) == "" {
			return invalid("wallet_accounts[%d].id is required", i)
		}
		if strings.TrimSpace(a.Name) == "" {
			return invalid("wallet_accounts[%d].name is required", i)
		}
		if a.AccountType == "" {
			return invalid("wallet_accounts[%d] (%s) needs account_type", i, a.Name)
		}
		if a.Currency == "" {
			a.Currency = "INR"
		}
	}
	return nil
}
