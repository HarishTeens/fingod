package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/harishteens/fingod/api/internal/domain"
	"github.com/jackc/pgx/v5"
)

// UnclassifiedAccountsError refuses a checkpoint because Wallet is showing an
// account fingod has never been told what to do with.
//
// This is the FD guard. Wallet types its fixed deposit `General` with
// isInvestmentAccount false — indistinguishable from a salary account — so
// inferring a role would have folded a 7.2 lakh deposit into cash and
// double-counted it against the manually tracked FD. Refusing is the whole
// point: a wrong net worth that looks right is worse than no net worth.
type UnclassifiedAccountsError struct{ Accounts []domain.WalletAccount }

func (e UnclassifiedAccountsError) Error() string {
	names := make([]string, len(e.Accounts))
	for i, a := range e.Accounts {
		names[i] = fmt.Sprintf("%s (%s)", a.Name, a.AccountType)
	}
	return "checkpoint refused: unclassified Wallet account(s): " + strings.Join(names, ", ")
}

// SaveCheckpoint writes one checkpoint and everything it holds, atomically.
//
// Re-posting the same as_of_date replaces that checkpoint's holdings and
// balances rather than appending, so a refresh that half-failed can simply be
// run again — the UNIQUE on as_of_date plus this replacement is what makes
// ingest idempotent.
func (s *Store) SaveCheckpoint(ctx context.Context, in *domain.CheckpointInput) (*domain.CheckpointResult, error) {
	// Account discovery commits on its own, before the checkpoint transaction
	// and outside it. A newly seen account has to survive the refusal it is
	// about to cause: rolling it back with the checkpoint would leave nothing
	// to classify, and the caller would be told to PATCH an id that does not
	// exist yet.
	unclassified, err := s.recordWalletAccounts(ctx, in.WalletAccounts)
	if err != nil {
		return nil, err
	}
	if len(unclassified) > 0 {
		return nil, UnclassifiedAccountsError{Accounts: unclassified}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	sources, err := json.Marshal(in.Sources)
	if err != nil {
		return nil, err
	}

	var (
		cp       domain.Checkpoint
		asOf     string
		usdINR   string
		srcJSON  string
		replaced bool
	)
	err = tx.QueryRow(ctx, `
		INSERT INTO checkpoints (as_of_date, usd_inr, sources, taken_at)
		VALUES ($1::text::date, $2::text::numeric, $3::text::jsonb, now())
		ON CONFLICT (as_of_date) DO UPDATE
		    SET usd_inr = EXCLUDED.usd_inr,
		        sources = EXCLUDED.sources,
		        taken_at = now()
		RETURNING id, as_of_date::text, taken_at, usd_inr::text, sources::text, created_at,
		          (xmax <> 0) AS replaced`,
		in.AsOfDate.String(), in.USDINR.String(), string(sources),
	).Scan(&cp.ID, &asOf, &cp.TakenAt, &usdINR, &srcJSON, &cp.CreatedAt, &replaced)
	if err != nil {
		return nil, fmt.Errorf("upsert checkpoint: %w", err)
	}
	if cp.AsOfDate, err = domain.ParseDate(asOf); err != nil {
		return nil, err
	}
	cp.USDINR = domain.Num(usdINR)
	if err := json.Unmarshal([]byte(srcJSON), &cp.Sources); err != nil {
		return nil, err
	}

	// Replace wholesale: a symbol sold since the last attempt at this date must
	// disappear, which an upsert-only path would never do.
	if _, err := tx.Exec(ctx, `DELETE FROM holdings WHERE checkpoint_id = $1`, cp.ID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM balances WHERE checkpoint_id = $1`, cp.ID); err != nil {
		return nil, err
	}

	var warnings []string
	for _, h := range in.Holdings {
		// value_inr is computed here, in NUMERIC, and never taken from the
		// source. Brokers round their own totals; the qty-diff identity only
		// holds if value == qty x price x fx exactly, and holdings_value_consistent
		// enforces that on the way in.
		var claimed *string
		if !h.ValueINR.Empty() {
			v := h.ValueINR.String()
			claimed = &v
		}
		var stored string
		var mismatch, noBasis bool
		err := tx.QueryRow(ctx, `
			INSERT INTO holdings (checkpoint_id, sleeve, symbol, name, isin,
			                      qty, price, currency, fx_rate, value_inr,
			                      avg_cost, invested_inr, invested_usd)
			SELECT $1, $2, $3, NULLIF($4,''), NULLIF($5,''),
			       $6::text::numeric, $7::text::numeric, $8, $9::text::numeric,
			       round($6::text::numeric * $7::text::numeric * $9::text::numeric, 2),
			       NULLIF($11,'')::numeric,
			       -- For us_equity the rupee cost is taken from us_cost_basis and
			       -- the payload's own invested_inr is discarded. INDmoney reports
			       -- it as a flat-92.0000 back-conversion of the USD cost, which
			       -- understated the basis and inflated the gain by
			       -- half again. The importer's FIFO at real per-date rates is the
			       -- only trustworthy source, so the server enforces it rather
			       -- than hoping every future refresh remembers to.
			       CASE WHEN $2 = 'us_equity' THEN b.cost_inr
			            ELSE NULLIF($12,'')::numeric END,
			       b.cost_usd
			  FROM (SELECT 1) AS _
			  -- Joining on qty as well as symbol is what makes a stale basis
			  -- fail closed: buy more of a stock and the recorded cost no longer
			  -- describes the position, so it does not join and invested_inr
			  -- lands NULL rather than quietly wrong.
			  LEFT JOIN us_cost_basis b
			         ON $2 = 'us_equity' AND b.symbol = $3
			        AND abs(b.qty - $6::text::numeric) <= 0.000001
			RETURNING value_inr::text,
			          ($10::text IS NOT NULL AND abs(value_inr - $10::text::numeric) > 1.00),
			          ($2 = 'us_equity' AND invested_inr IS NULL)`,
			cp.ID, h.Sleeve, h.Symbol, h.Name, h.ISIN,
			h.Qty.String(), h.Price.String(), h.Currency, h.FXRate.String(), claimed,
			h.AvgCost.String(), h.InvestedINR.String(),
		).Scan(&stored, &mismatch, &noBasis)
		if err != nil {
			return nil, fmt.Errorf("insert holding %s/%s: %w", h.Sleeve, h.Symbol, err)
		}
		if mismatch {
			warnings = append(warnings, fmt.Sprintf(
				"%s/%s: source reported %s but qty x price x fx is %s — stored the computed figure",
				h.Sleeve, h.Symbol, h.ValueINR, stored))
		}
		if noBasis {
			warnings = append(warnings, fmt.Sprintf(
				"us_equity/%s: no cost basis for qty %s — returns will read as blank until "+
					"`make import-us-orders` is re-run against a fresh INDmoney order report",
				h.Symbol, h.Qty))
		}
	}

	for _, b := range in.Balances {
		meta, err := json.Marshal(orEmptyMap(b.Meta))
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO balances (checkpoint_id, kind, ref, amount_inr, meta)
			VALUES ($1, $2, $3, $4::text::numeric, $5::text::jsonb)`,
			cp.ID, b.Kind, b.Ref, b.AmountINR.String(), string(meta),
		); err != nil {
			return nil, fmt.Errorf("insert balance %s/%s: %w", b.Kind, b.Ref, err)
		}
	}

	// Splitwise is not in the payload by design — it is a standing list, and a
	// weekly refresh should not re-ask for a figure that only moves when the owner
	// says so. Snapshotting here keeps each checkpoint's history honest instead
	// of back-applying today's number to every past week.
	splitwise, err := snapshotSplitwise(ctx, tx, cp.ID)
	if err != nil {
		return nil, fmt.Errorf("snapshot splitwise: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &domain.CheckpointResult{
		Checkpoint: cp,
		Holdings:   len(in.Holdings),
		Balances:   len(in.Balances) + splitwise,
		Replaced:   replaced,
		Warnings:   warnings,
	}, nil
}

// ListCheckpoints returns checkpoints newest first, without their rows.
func (s *Store) ListCheckpoints(ctx context.Context, limit int) ([]domain.Checkpoint, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, as_of_date::text, taken_at, usd_inr::text, sources::text, created_at
		  FROM checkpoints
		 ORDER BY checkpoints.as_of_date DESC
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.Checkpoint{}
	for rows.Next() {
		cp, err := scanCheckpoint(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *cp)
	}
	return out, rows.Err()
}

// ErrNotFound is returned when a checkpoint date has nothing stored against it.
var ErrNotFound = errors.New("not found")

// GetCheckpoint reads one checkpoint with its holdings and balances.
func (s *Store) GetCheckpoint(ctx context.Context, at domain.Date) (*domain.Checkpoint, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT id, as_of_date::text, taken_at, usd_inr::text, sources::text, created_at
		  FROM checkpoints WHERE as_of_date = $1::text::date`, at.String())
	cp, err := scanCheckpoint(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	hrows, err := s.pool.Query(ctx, `
		SELECT sleeve, symbol, COALESCE(name,''), COALESCE(isin,''),
		       qty::text, price::text, currency, fx_rate::text, value_inr::text,
		       COALESCE(avg_cost::text,''), COALESCE(invested_inr::text,''),
		       COALESCE(invested_usd::text,'')
		  FROM holdings WHERE checkpoint_id = $1
		 -- Qualified: a bare value_inr would sort the text cast, putting
		 -- ₹9,999 above ₹10,00,000.
		 ORDER BY sleeve, holdings.value_inr DESC`, cp.ID)
	if err != nil {
		return nil, err
	}
	defer hrows.Close()
	cp.Holdings = []domain.Holding{}
	for hrows.Next() {
		var h domain.Holding
		if err := hrows.Scan(&h.Sleeve, &h.Symbol, &h.Name, &h.ISIN,
			&h.Qty, &h.Price, &h.Currency, &h.FXRate, &h.ValueINR,
			&h.AvgCost, &h.InvestedINR, &h.InvestedUSD); err != nil {
			return nil, err
		}
		cp.Holdings = append(cp.Holdings, h)
	}
	if err := hrows.Err(); err != nil {
		return nil, err
	}

	brows, err := s.pool.Query(ctx, `
		SELECT kind, ref, amount_inr::text, meta::text
		  FROM balances WHERE checkpoint_id = $1
		 ORDER BY kind, ref`, cp.ID)
	if err != nil {
		return nil, err
	}
	defer brows.Close()
	cp.Balances = []domain.Balance{}
	for brows.Next() {
		var b domain.Balance
		var meta string
		if err := brows.Scan(&b.Kind, &b.Ref, &b.AmountINR, &meta); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(meta), &b.Meta); err != nil {
			return nil, err
		}
		cp.Balances = append(cp.Balances, b)
	}
	return cp, brows.Err()
}

type scanner interface{ Scan(dest ...any) error }

func scanCheckpoint(row scanner) (*domain.Checkpoint, error) {
	var (
		cp      domain.Checkpoint
		asOf    string
		usdINR  string
		srcJSON string
		taken   time.Time
	)
	if err := row.Scan(&cp.ID, &asOf, &taken, &usdINR, &srcJSON, &cp.CreatedAt); err != nil {
		return nil, err
	}
	d, err := domain.ParseDate(asOf)
	if err != nil {
		return nil, err
	}
	cp.AsOfDate = d
	cp.TakenAt = taken
	cp.USDINR = domain.Num(usdINR)
	if err := json.Unmarshal([]byte(srcJSON), &cp.Sources); err != nil {
		return nil, err
	}
	return &cp, nil
}

func orEmptyMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}
