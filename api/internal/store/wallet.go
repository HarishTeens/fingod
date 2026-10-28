package store

import (
	"context"

	"github.com/harishteens/fingod/api/internal/domain"
	"github.com/jackc/pgx/v5"
)

// recordWalletAccounts registers every account the refresh saw and returns the
// ones still lacking a role. It commits independently of the checkpoint so a
// newly discovered account is classifiable even though its discovery is what
// blocks the checkpoint.
//
// role is set only on first sight, from wallet_default_role, which returns NULL
// for General and anything unrecognised. An existing role is never overwritten:
// classification is a decision made once by hand, and a rename or a type change
// upstream must not silently undo it.
func (s *Store) recordWalletAccounts(ctx context.Context, accounts []domain.WalletAccount) ([]domain.WalletAccount, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := upsertWalletAccounts(ctx, tx, accounts); err != nil {
		return nil, err
	}
	unclassified, err := unclassifiedAccounts(ctx, tx)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return unclassified, nil
}

func upsertWalletAccounts(ctx context.Context, tx pgx.Tx, accounts []domain.WalletAccount) error {
	for _, a := range accounts {
		if _, err := tx.Exec(ctx, `
			INSERT INTO wallet_accounts (id, name, account_type, currency, role, last_seen_at, updated_at)
			VALUES ($1, $2, $3, $4, wallet_default_role($3), now(), now())
			ON CONFLICT (id) DO UPDATE
			    SET name         = EXCLUDED.name,
			        account_type = EXCLUDED.account_type,
			        currency     = EXCLUDED.currency,
			        last_seen_at = now(),
			        updated_at   = now()`,
			a.ID, a.Name, a.AccountType, a.Currency,
		); err != nil {
			return err
		}
	}
	return nil
}

// unclassifiedAccounts lists accounts with no role. Any row here blocks the
// checkpoint — including an account that has stopped appearing in Wallet, which
// should be classified 'ignore' rather than left NULL.
func unclassifiedAccounts(ctx context.Context, tx pgx.Tx) ([]domain.WalletAccount, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, name, account_type, currency
		  FROM wallet_accounts
		 WHERE role IS NULL
		 ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []domain.WalletAccount
	for rows.Next() {
		var a domain.WalletAccount
		if err := rows.Scan(&a.ID, &a.Name, &a.AccountType, &a.Currency); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// WalletAccounts lists every known account and its classification.
func (s *Store) WalletAccounts(ctx context.Context) ([]domain.WalletAccount, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, account_type, currency, role, role_note, balance_source, external_ref
		  FROM wallet_accounts
		 ORDER BY role IS NOT NULL, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.WalletAccount{}
	for rows.Next() {
		var a domain.WalletAccount
		if err := rows.Scan(&a.ID, &a.Name, &a.AccountType, &a.Currency, &a.Role, &a.RoleNote,
			&a.BalanceSource, &a.ExternalRef); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ClassifyWalletAccount sets an account's role and, optionally, where its
// balance is read from. A nil field is left alone, so classifying a role does
// not silently reset a balance source someone set deliberately.
func (s *Store) ClassifyWalletAccount(ctx context.Context, id string, role, note, source, externalRef *string) (*domain.WalletAccount, error) {
	var a domain.WalletAccount
	err := s.pool.QueryRow(ctx, `
		UPDATE wallet_accounts
		   SET role           = COALESCE($2, role),
		       role_note      = COALESCE($3, role_note),
		       balance_source = COALESCE($4, balance_source),
		       external_ref   = COALESCE($5, external_ref),
		       updated_at     = now()
		 WHERE id = $1
		 RETURNING id, name, account_type, currency, role, role_note, balance_source, external_ref`,
		id, role, note, source, externalRef,
	).Scan(&a.ID, &a.Name, &a.AccountType, &a.Currency, &a.Role, &a.RoleNote,
		&a.BalanceSource, &a.ExternalRef)
	if err == pgx.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}
