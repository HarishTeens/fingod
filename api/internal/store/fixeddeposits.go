package store

import (
	"context"
	"errors"

	"github.com/harishteens/fingod/api/internal/domain"
	"github.com/jackc/pgx/v5"
)

const fdColumns = `id, bank, principal::text, rate_pct::text,
	start_date::text, maturity_date::text, closed_at::text, compounding, COALESCE(note,'')`

// FixedDeposits lists deposits, open ones first, newest start date first.
func (s *Store) FixedDeposits(ctx context.Context, includeClosed bool) ([]domain.FixedDeposit, error) {
	q := `SELECT ` + fdColumns + ` FROM fixed_deposits`
	if !includeClosed {
		q += ` WHERE closed_at IS NULL`
	}
	// Qualified for the same reason as elsewhere: start_date is also selected as
	// a text cast, and a bare reference would sort that instead.
	q += ` ORDER BY closed_at IS NOT NULL, fixed_deposits.start_date DESC, fixed_deposits.id`

	rows, err := s.pool.Query(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.FixedDeposit{}
	for rows.Next() {
		fd, err := scanFD(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *fd)
	}
	return out, rows.Err()
}

func (s *Store) CreateFixedDeposit(ctx context.Context, fd *domain.FixedDeposit) (*domain.FixedDeposit, error) {
	row := s.pool.QueryRow(ctx, `
		INSERT INTO fixed_deposits (bank, principal, rate_pct, start_date, maturity_date, closed_at, compounding, note)
		VALUES ($1, $2::text::numeric, $3::text::numeric, $4::text::date, $5::text::date,
		        $6::text::date, $7, NULLIF($8,''))
		RETURNING `+fdColumns,
		fd.Bank, fd.Principal.String(), fd.RatePct.String(),
		fd.StartDate.String(), fd.MaturityDate.String(), dateOrNil(fd.ClosedAt), fd.Compounding, fd.Note)
	return scanFD(row)
}

func (s *Store) UpdateFixedDeposit(ctx context.Context, id int64, fd *domain.FixedDeposit) (*domain.FixedDeposit, error) {
	row := s.pool.QueryRow(ctx, `
		UPDATE fixed_deposits
		   SET bank = $2, principal = $3::text::numeric, rate_pct = $4::text::numeric,
		       start_date = $5::text::date, maturity_date = $6::text::date,
		       closed_at = $7::text::date, compounding = $8, note = NULLIF($9,'')
		 WHERE id = $1
		 RETURNING `+fdColumns,
		id, fd.Bank, fd.Principal.String(), fd.RatePct.String(),
		fd.StartDate.String(), fd.MaturityDate.String(), dateOrNil(fd.ClosedAt), fd.Compounding, fd.Note)
	fdOut, err := scanFD(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return fdOut, err
}

// DeleteFixedDeposit removes a deposit outright. Closing one (setting
// closed_at) is almost always what is wanted instead: it keeps the deposit
// valuing correctly at every checkpoint taken while it was running, where a
// delete rewrites that history to say it never existed.
func (s *Store) DeleteFixedDeposit(ctx context.Context, id int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM fixed_deposits WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func scanFD(row scanner) (*domain.FixedDeposit, error) {
	var (
		fd       domain.FixedDeposit
		start    string
		maturity string
		closed   *string
	)
	if err := row.Scan(&fd.ID, &fd.Bank, &fd.Principal, &fd.RatePct,
		&start, &maturity, &closed, &fd.Compounding, &fd.Note); err != nil {
		return nil, err
	}
	var err error
	if fd.StartDate, err = domain.ParseDate(start); err != nil {
		return nil, err
	}
	if fd.MaturityDate, err = domain.ParseDate(maturity); err != nil {
		return nil, err
	}
	if closed != nil {
		d, err := domain.ParseDate(*closed)
		if err != nil {
			return nil, err
		}
		fd.ClosedAt = &d
	}
	return &fd, nil
}

func dateOrNil(d *domain.Date) *string {
	if d == nil {
		return nil
	}
	s := d.String()
	return &s
}
