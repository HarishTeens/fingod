package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

// The shape Wallet's get_records actually returns, mapped as the refresh skill
// maps it. Decoding this end to end is the contract test for that mapping.
func TestDecodesTheWalletRecordShape(t *testing.T) {
	const payload = `{"transactions":[{
	  "id": "e05ed7f6-1111-2222-3333-444455556666",
	  "txn_date": "2026-09-05",
	  "amount_inr": -500,
	  "currency": "INR",
	  "account": "Card A",
	  "note": "Coffee",
	  "category_id": "5c5c1771-0000-0000-0000-000000000000",
	  "category": "Food & drinks",
	  "category_top": "Life & Entertainment",
	  "is_transfer": false,
	  "labels": ["One-Time"],
	  "raw": {"recordState": "cleared", "source": "ios"}
	}]}`
	var b TransactionBatch
	if err := json.Unmarshal([]byte(payload), &b); err != nil {
		t.Fatal(err)
	}
	if err := b.Validate(); err != nil {
		t.Fatal(err)
	}
	tx := b.Transactions[0]
	if tx.AmountINR != "-500" {
		t.Errorf("amount = %q — negative is an expense and the sign must survive", tx.AmountINR)
	}
	if tx.CategoryTop != "Life & Entertainment" || tx.Category != "Food & drinks" {
		t.Errorf("category %q under %q", tx.Category, tx.CategoryTop)
	}
	if len(tx.Labels) != 1 || tx.Labels[0] != "One-Time" {
		t.Errorf("labels = %v", tx.Labels)
	}
}

func TestTransactionRequiresWalletsOwnID(t *testing.T) {
	// Without it there is no idempotency: a refresh overlapping the previous
	// one would duplicate every record in the overlap.
	b := TransactionBatch{Transactions: []Transaction{{TxnDate: mustDate("2026-09-05"), AmountINR: "-100"}}}
	err := b.Validate()
	if err == nil || !strings.Contains(err.Error(), "idempotent") {
		t.Errorf("record without an id gave %v", err)
	}
}

func TestTransactionRejectsDuplicateIDs(t *testing.T) {
	b := TransactionBatch{Transactions: []Transaction{
		{ID: "a", TxnDate: mustDate("2026-09-05"), AmountINR: "-100"},
		{ID: "a", TxnDate: mustDate("2026-09-05"), AmountINR: "-200"},
	}}
	if err := b.Validate(); err == nil {
		t.Error("the same id twice in one batch was accepted — the second would silently win")
	}
}

func TestTransactionDeduplicatesLabels(t *testing.T) {
	// transaction_labels is keyed on (transaction_id, label), so a repeat would
	// abort the whole batch over one sloppy record.
	b := TransactionBatch{Transactions: []Transaction{{
		ID: "a", TxnDate: mustDate("2026-09-05"), AmountINR: "-100",
		Labels: []string{"Trip", "Trip", "  ", "Food"},
	}}}
	if err := b.Validate(); err != nil {
		t.Fatal(err)
	}
	if got := b.Transactions[0].Labels; len(got) != 2 || got[0] != "Trip" || got[1] != "Food" {
		t.Errorf("labels = %v, want [Trip Food]", got)
	}
}

func TestEmptyBatchIsRejected(t *testing.T) {
	var b TransactionBatch
	if err := b.Validate(); err == nil {
		t.Error("an empty batch was accepted")
	}
}
