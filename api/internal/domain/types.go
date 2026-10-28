// Package domain holds the shapes shared between the HTTP layer and the store.
// It deliberately contains no database and no HTTP imports.
package domain

import "time"

// Sleeves that carry a quantity, and so feed the qty-diff engine.
const (
	SleeveINEquity = "in_equity"
	SleeveINMF     = "in_mf"
	SleeveUSEquity = "us_equity"
	SleeveGold     = "gold"
	SleeveDebt     = "debt"
	SleeveBTC      = "btc"
)

// Gold and debt are sleeves of their own even though Kite delivers both inside
// the equity feed: gold is 12.7% of it and debt 5.2%, and neither is equity.
// Classification is per-symbol at ingest, keyed on ISIN.
//
// The order is fixed and load-bearing — it is the order chart colours are
// assigned in, and it was chosen so that adjacent pairs clear the CVD checks.
// Reordering means re-running the palette validator.
var Sleeves = []string{SleeveINEquity, SleeveINMF, SleeveUSEquity, SleeveGold, SleeveDebt, SleeveBTC}

// SleeveInsurance is a *trade* sleeve only. An endowment policy has no quantity
// and no price, so there is nothing for a checkpoint to snapshot — but a
// redeemed one is a closed position with a realised result, and that has to
// land somewhere.
const SleeveInsurance = "insurance"

// TradeSleeves is what a closed position may be filed under: everything that
// can be held, plus the things that can only ever be closed.
var TradeSleeves = append(append([]string{}, Sleeves...), SleeveInsurance)

// Balance kinds: positions with no quantity.
const (
	KindCash       = "cash"
	KindCreditCard = "credit_card"
	KindEPF        = "epf"
	KindSplitwise  = "splitwise"
)

var BalanceKinds = []string{KindCash, KindCreditCard, KindEPF, KindSplitwise}

// Wallet account roles. An account with no role blocks the checkpoint.
const (
	RoleCash       = "cash"
	RoleCreditCard = "credit_card"
	RoleIgnore     = "ignore"
)

var WalletRoles = []string{RoleCash, RoleCreditCard, RoleIgnore}

// Per-source health recorded on the checkpoint. A stale source is carried
// forward and excluded from attribution rather than booked as a move to zero.
const (
	SourceOK    = "ok"
	SourceStale = "stale"
)

// Checkpoint is one immutable snapshot of every position at a date.
type Checkpoint struct {
	ID        int64             `json:"id"`
	AsOfDate  Date              `json:"as_of_date"`
	TakenAt   time.Time         `json:"taken_at"`
	USDINR    Num               `json:"usd_inr"`
	Sources   map[string]string `json:"sources"`
	CreatedAt time.Time         `json:"created_at"`

	// Populated on the detail read only.
	Holdings []Holding `json:"holdings,omitempty"`
	Balances []Balance `json:"balances,omitempty"`
}

type Holding struct {
	Sleeve   string `json:"sleeve"`
	Symbol   string `json:"symbol"`
	Name     string `json:"name,omitempty"`
	ISIN     string `json:"isin,omitempty"`
	Qty      Num    `json:"qty"`
	Price    Num    `json:"price"`               // per unit, in Currency
	Currency string `json:"currency,omitempty"`  // defaults to INR
	FXRate   Num    `json:"fx_rate,omitempty"`   // Currency → INR; defaults to 1, or usd_inr for USD
	ValueINR Num    `json:"value_inr,omitempty"` // server-computed; a supplied value is only cross-checked

	// Cost basis. Optional — a holding without it simply reports no return.
	// AvgCost is per unit in Currency and is for display; InvestedINR is the
	// rupees actually put in, at the rates of the day, and is what return is
	// computed from.
	AvgCost     Num `json:"avg_cost,omitempty"`
	InvestedINR Num `json:"invested_inr,omitempty"`

	// InvestedUSD is the same cost in the currency the position actually trades
	// in, and it is what makes a rupee return interpretable. A US holding up
	// 31% in rupees and 27% in dollars has earned the difference from the
	// currency, not the company; without both numbers the two are
	// indistinguishable, which is precisely how a flat-rate conversion passed
	// unnoticed long enough to inflate the sleeve by half again.
	//
	// Set by the server from us_cost_basis, never from an ingest payload.
	InvestedUSD Num `json:"invested_usd,omitempty"`
}

type Balance struct {
	Kind      string         `json:"kind"`
	Ref       string         `json:"ref"`
	AmountINR Num            `json:"amount_inr"` // credit_card is POSITIVE = outstanding
	Meta      map[string]any `json:"meta,omitempty"`
}

// WalletAccount mirrors one row of wallet_accounts. Ingest sends what it saw;
// Role is never set from the payload — classification is a human decision made
// once and persisted, because Wallet exposes no field identifying a deposit.
type WalletAccount struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	AccountType string  `json:"account_type"`
	Currency    string  `json:"currency,omitempty"`
	Role        *string `json:"role,omitempty"`
	RoleNote    *string `json:"role_note,omitempty"`

	// BalanceSource says where the checkpoint's figure comes from. Wallet
	// accounts are not bank-synced, so their balances are running totals of
	// manual entries and can drift; an account whose bank INDmoney can see is
	// better read from there. ExternalRef names the INDmoney SA row.
	BalanceSource string  `json:"balance_source,omitempty"`
	ExternalRef   *string `json:"external_ref,omitempty"`
}

// Where a Wallet account's balance is read from.
const (
	BalanceFromWallet   = "wallet"
	BalanceFromINDmoney = "indmoney"
)

var BalanceSources = []string{BalanceFromWallet, BalanceFromINDmoney}

// CheckpointInput is the POST /api/v1/checkpoints payload.
type CheckpointInput struct {
	AsOfDate       Date              `json:"as_of_date"`
	USDINR         Num               `json:"usd_inr"`
	Sources        map[string]string `json:"sources"`
	Holdings       []Holding         `json:"holdings"`
	Balances       []Balance         `json:"balances"`
	WalletAccounts []WalletAccount   `json:"wallet_accounts"`
}

// CheckpointResult reports what was written. Warnings are non-fatal: a holding
// whose broker-supplied total disagreed with qty x price x fx by more than a
// rupee is stored with the computed figure and flagged here.
type CheckpointResult struct {
	Checkpoint Checkpoint `json:"checkpoint"`
	Holdings   int        `json:"holdings_written"`
	Balances   int        `json:"balances_written"`
	Replaced   bool       `json:"replaced"`
	Warnings   []string   `json:"warnings,omitempty"`
}
