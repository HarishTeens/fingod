package store

import (
	"context"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/harishteens/fingod/api/migrations"
)

// Migrate applies every embedded migration that has not run yet, in filename
// order, and records it under the same version key `make migrate` uses (the
// basename without .sql) so the shell path and this one are interchangeable.
//
// Each file runs inside its own transaction together with its bookkeeping row:
// a migration that fails halfway leaves no partial schema and no version entry.
// The files themselves also carry BEGIN/COMMIT, which Postgres tolerates as a
// no-op inside an open transaction.
func (s *Store) Migrate(ctx context.Context) ([]string, error) {
	_, err := s.pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`)
	if err != nil {
		return nil, fmt.Errorf("create schema_migrations: %w", err)
	}

	entries, err := fs.Glob(migrations.FS, "*.sql")
	if err != nil {
		return nil, err
	}
	sort.Strings(entries)

	var applied []string
	for _, name := range entries {
		version := strings.TrimSuffix(name, ".sql")

		var exists bool
		if err := s.pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)`, version,
		).Scan(&exists); err != nil {
			return applied, fmt.Errorf("check %s: %w", version, err)
		}
		if exists {
			continue
		}

		body, err := fs.ReadFile(migrations.FS, name)
		if err != nil {
			return applied, err
		}

		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return applied, err
		}
		if _, err := tx.Exec(ctx, string(body)); err != nil {
			_ = tx.Rollback(ctx)
			return applied, fmt.Errorf("apply %s: %w", version, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migrations (version) VALUES ($1)`, version,
		); err != nil {
			_ = tx.Rollback(ctx)
			return applied, fmt.Errorf("record %s: %w", version, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return applied, fmt.Errorf("commit %s: %w", version, err)
		}
		applied = append(applied, version)
	}
	return applied, nil
}
