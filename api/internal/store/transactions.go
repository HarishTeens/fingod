package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/harishteens/fingod/api/internal/domain"
)

// UpsertTransactions writes a batch idempotently, keyed on Wallet's record id.
//
// One transaction for the whole batch: a refresh that fails halfway should
// leave nothing behind rather than a partial month that the next run has no way
// to detect.
func (s *Store) UpsertTransactions(ctx context.Context, batch []domain.Transaction) (*domain.TransactionResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	res := &domain.TransactionResult{Received: len(batch)}

	for _, t := range batch {
		raw, err := json.Marshal(orEmptyAny(t.Raw))
		if err != nil {
			return nil, err
		}

		var inserted bool
		err = tx.QueryRow(ctx, `
			INSERT INTO transactions (id, txn_date, amount_inr, currency, account, payee, note,
			                          category_id, category, category_top, is_transfer, raw, ingested_at)
			VALUES ($1, $2::text::date, $3::text::numeric, $4,
			        NULLIF($5,''), NULLIF($6,''), NULLIF($7,''),
			        NULLIF($8,''), NULLIF($9,''), NULLIF($10,''), $11, $12::text::jsonb, now())
			ON CONFLICT (id) DO UPDATE
			    SET txn_date = EXCLUDED.txn_date, amount_inr = EXCLUDED.amount_inr,
			        currency = EXCLUDED.currency, account = EXCLUDED.account,
			        payee = EXCLUDED.payee, note = EXCLUDED.note,
			        category_id = EXCLUDED.category_id, category = EXCLUDED.category,
			        category_top = EXCLUDED.category_top, is_transfer = EXCLUDED.is_transfer,
			        raw = EXCLUDED.raw, ingested_at = now()
			RETURNING (xmax = 0)`,
			t.ID, t.TxnDate.String(), t.AmountINR.String(), t.Currency,
			t.Account, t.Payee, t.Note, t.CategoryID, t.Category, t.CategoryTop,
			t.IsTransfer, string(raw),
		).Scan(&inserted)
		if err != nil {
			return nil, fmt.Errorf("upsert transaction %s: %w", t.ID, err)
		}
		if inserted {
			res.Inserted++
		} else {
			res.Updated++
		}

		// Labels are replaced wholesale: removing one in Wallet has to remove
		// it here, which an insert-only path would never do.
		if _, err := tx.Exec(ctx, `DELETE FROM transaction_labels WHERE transaction_id = $1`, t.ID); err != nil {
			return nil, err
		}
		for _, label := range t.Labels {
			if _, err := tx.Exec(ctx,
				`INSERT INTO transaction_labels (transaction_id, label) VALUES ($1, $2)`, t.ID, label,
			); err != nil {
				return nil, fmt.Errorf("label %q on %s: %w", label, t.ID, err)
			}
			res.Labels++
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(min(txn_date)::text,''), COALESCE(max(txn_date)::text,'')
		  FROM transactions`).Scan(&res.Earliest, &res.Latest); err != nil {
		return nil, err
	}
	return res, nil
}

// TransactionStats reports how much history is stored, so a refresh knows how
// far back to page rather than re-pulling everything against Wallet's 300
// requests an hour.
func (s *Store) TransactionStats(ctx context.Context) (count int, latest string, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT count(*), COALESCE(max(txn_date)::text, '') FROM transactions`).Scan(&count, &latest)
	return
}

func orEmptyAny(v any) any {
	if v == nil {
		return map[string]any{}
	}
	return v
}
