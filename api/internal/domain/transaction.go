package domain

import (
	"strings"
)

// Transaction is one Wallet record, flattened.
//
// The id is Wallet's own uuid, which is what makes ingest idempotent: a refresh
// that overlaps the previous one by a few days re-sends records already stored
// and they update in place rather than duplicating. That overlap is deliberate
// — Wallet lets a record's date be edited after the fact, so a strictly
// forward-only window would miss corrections.
type Transaction struct {
	ID          string   `json:"id"`
	TxnDate     Date     `json:"txn_date"`
	AmountINR   Num      `json:"amount_inr"` // negative = expense, positive = income
	Currency    string   `json:"currency,omitempty"`
	Account     string   `json:"account,omitempty"`
	Payee       string   `json:"payee,omitempty"`
	Note        string   `json:"note,omitempty"`
	CategoryID  string   `json:"category_id,omitempty"`
	Category    string   `json:"category,omitempty"`     // leaf, e.g. "Groceries"
	CategoryTop string   `json:"category_top,omitempty"` // parent, e.g. "Food & Drinks"
	IsTransfer  bool     `json:"is_transfer,omitempty"`
	Labels      []string `json:"labels,omitempty"`
	Raw         any      `json:"raw,omitempty"`
}

// TransactionBatch is the POST /api/v1/transactions payload.
type TransactionBatch struct {
	Transactions []Transaction `json:"transactions"`
}

// TransactionResult reports what landed.
type TransactionResult struct {
	Received int    `json:"received"`
	Inserted int    `json:"inserted"`
	Updated  int    `json:"updated"`
	Labels   int    `json:"labels_written"`
	Earliest string `json:"earliest,omitempty"`
	Latest   string `json:"latest,omitempty"`
}

func (b *TransactionBatch) Validate() error {
	if len(b.Transactions) == 0 {
		return invalid("transactions is empty — send at least one record")
	}
	seen := make(map[string]bool, len(b.Transactions))
	for i := range b.Transactions {
		t := &b.Transactions[i]
		if strings.TrimSpace(t.ID) == "" {
			return invalid("transactions[%d].id is required — use Wallet's own record id, which is what makes this idempotent", i)
		}
		if seen[t.ID] {
			return invalid("transactions contains id %s twice", t.ID)
		}
		seen[t.ID] = true

		if t.TxnDate.IsZero() {
			return invalid("transactions[%d] (%s) needs a txn_date", i, t.ID)
		}
		if t.AmountINR.Empty() {
			return invalid("transactions[%d] (%s) needs an amount_inr", i, t.ID)
		}
		if t.Currency == "" {
			t.Currency = "INR"
		}
		t.Currency = strings.ToUpper(t.Currency)

		// Deduplicate labels rather than letting the composite primary key
		// reject the whole batch over a repeat in one record.
		if len(t.Labels) > 0 {
			uniq := make([]string, 0, len(t.Labels))
			seenLabel := map[string]bool{}
			for _, l := range t.Labels {
				l = strings.TrimSpace(l)
				if l == "" || seenLabel[l] {
					continue
				}
				seenLabel[l] = true
				uniq = append(uniq, l)
			}
			t.Labels = uniq
		}
	}
	return nil
}
