package store

import (
	"context"
	"encoding/json"

	"github.com/harishteens/fingod/api/internal/domain"
)

// RefreshState is everything /refresh needs to know before it calls a single
// MCP server: how far behind it is, what is still unclassified, and what the
// manual figures were last time so it can offer them as defaults.
//
// One request rather than five. A refresh that has to make five calls just to
// orient itself has five chances to half-fail and leave the operator guessing
// which half succeeded.
type RefreshState struct {
	LastCheckpoint *domain.Checkpoint `json:"last_checkpoint"`
	// Always emitted, empty when there is no history. A field that vanishes
	// when it is empty forces every caller to handle two shapes.
	LastTransactionDate  string                    `json:"last_transaction_date"`
	TransactionCount     int                       `json:"transaction_count"`
	UnclassifiedAccounts []domain.WalletAccount    `json:"unclassified_accounts"`
	Splitwise            []domain.SplitwiseBalance `json:"splitwise"`
	FixedDeposits        []domain.FixedDeposit     `json:"fixed_deposits"`
	TargetAllocation     map[string]any            `json:"target_allocation"`
	Sleeves              []string                  `json:"sleeves"`

	// PreviousManual carries forward the figures no MCP can supply, so the
	// operator confirms a number instead of retyping it.
	PreviousManual map[string]domain.Holding `json:"previous_manual,omitempty"`
}

func (s *Store) RefreshState(ctx context.Context) (*RefreshState, error) {
	out := &RefreshState{
		UnclassifiedAccounts: []domain.WalletAccount{},
		Sleeves:              domain.Sleeves,
	}

	checkpoints, err := s.ListCheckpoints(ctx, 1)
	if err != nil {
		return nil, err
	}
	if len(checkpoints) > 0 {
		full, err := s.GetCheckpoint(ctx, checkpoints[0].AsOfDate)
		if err != nil {
			return nil, err
		}
		out.PreviousManual = map[string]domain.Holding{}
		for _, h := range full.Holdings {
			if h.Sleeve == domain.SleeveBTC {
				out.PreviousManual[h.Symbol] = h
			}
		}
		full.Holdings, full.Balances = nil, nil
		out.LastCheckpoint = full
	}

	if out.TransactionCount, out.LastTransactionDate, err = s.TransactionStats(ctx); err != nil {
		return nil, err
	}

	accounts, err := s.WalletAccounts(ctx)
	if err != nil {
		return nil, err
	}
	for _, a := range accounts {
		if a.Role == nil {
			out.UnclassifiedAccounts = append(out.UnclassifiedAccounts, a)
		}
	}

	if out.Splitwise, err = s.SplitwiseBalances(ctx); err != nil {
		return nil, err
	}
	if out.FixedDeposits, err = s.FixedDeposits(ctx, false); err != nil {
		return nil, err
	}

	var target string
	if err := s.pool.QueryRow(ctx,
		`SELECT COALESCE((SELECT value::text FROM settings WHERE key='target_allocation'), '{}')`,
	).Scan(&target); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(target), &out.TargetAllocation); err != nil {
		return nil, err
	}
	return out, nil
}

// TargetAllocation reads the settings row that drives the rebalance table.
func (s *Store) TargetAllocation(ctx context.Context) (map[string]float64, error) {
	var raw string
	if err := s.pool.QueryRow(ctx,
		`SELECT COALESCE((SELECT value::text FROM settings WHERE key='target_allocation'), '{}')`,
	).Scan(&raw); err != nil {
		return nil, err
	}
	out := map[string]float64{}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SetTargetAllocation replaces the target. Validation lives in the HTTP layer;
// by here the percentages are known to total 100.
func (s *Store) SetTargetAllocation(ctx context.Context, target map[string]float64) error {
	raw, err := json.Marshal(target)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO settings (key, value, updated_at)
		VALUES ('target_allocation', $1::text::jsonb, now())
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
		string(raw))
	return err
}

// FlowFlagThreshold is the share of a sleeve a single holding's flow may reach
// before it is flagged as a probable unrecorded corporate action.
func (s *Store) FlowFlagThreshold(ctx context.Context) (domain.Num, error) {
	var raw string
	if err := s.pool.QueryRow(ctx,
		`SELECT COALESCE((SELECT value::text FROM settings WHERE key='flow_flag_threshold'), '0.25')`,
	).Scan(&raw); err != nil {
		return "0.25", err
	}
	return domain.Num(raw), nil
}
