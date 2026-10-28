package store

import (
	"context"

	"github.com/harishteens/fingod/api/internal/domain"
	"github.com/jackc/pgx/v5"
)

// SplitwiseBalances lists everyone fingod knows about, largest debt to you
// first.
func (s *Store) SplitwiseBalances(ctx context.Context) ([]domain.SplitwiseBalance, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT person, amount_inr::text, COALESCE(note,''), to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		  FROM splitwise_balances
		 -- Qualified deliberately. A bare "amount_inr" here would bind to the
		 -- OUTPUT column, which is amount_inr::text (a cast keeps the name), and
		 -- sort the money as a string: ₹9 would outrank ₹10.
		 ORDER BY splitwise_balances.amount_inr DESC, person`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.SplitwiseBalance{}
	for rows.Next() {
		var b domain.SplitwiseBalance
		if err := rows.Scan(&b.Person, &b.AmountINR, &b.Note, &b.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// SetSplitwiseBalance adds a person or updates what they owe. Upsert rather
// than separate create and update: from the outside this is one action — "Ravi
// owes me 3,200 now" — whether or not Ravi was already on the list.
func (s *Store) SetSplitwiseBalance(ctx context.Context, b *domain.SplitwiseBalance) (*domain.SplitwiseBalance, error) {
	var out domain.SplitwiseBalance
	err := s.pool.QueryRow(ctx, `
		INSERT INTO splitwise_balances (person, amount_inr, note, updated_at)
		VALUES ($1, $2::text::numeric, NULLIF($3,''), now())
		ON CONFLICT (person) DO UPDATE
		    SET amount_inr = EXCLUDED.amount_inr,
		        note       = COALESCE(EXCLUDED.note, splitwise_balances.note),
		        updated_at = now()
		RETURNING person, amount_inr::text, COALESCE(note,''), to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
		b.Person, b.AmountINR.String(), b.Note,
	).Scan(&out.Person, &out.AmountINR, &out.Note, &out.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *Store) DeleteSplitwiseBalance(ctx context.Context, person string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM splitwise_balances WHERE person = $1`, person)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// snapshotSplitwise copies the standing balances into a checkpoint.
//
// The checkpoint payload deliberately cannot carry splitwise rows: there is one
// place these live, and a refresh should never re-ask for a number that only
// changes when you say it does. History then keeps what was true at each
// checkpoint rather than back-applying today's figure.
func snapshotSplitwise(ctx context.Context, tx pgx.Tx, checkpointID int64) (int, error) {
	tag, err := tx.Exec(ctx, `
		INSERT INTO balances (checkpoint_id, kind, ref, amount_inr, meta)
		SELECT $1, 'splitwise', person, amount_inr,
		       jsonb_build_object('source', 'splitwise_balances', 'note', COALESCE(note, ''))
		  FROM splitwise_balances`, checkpointID)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}
