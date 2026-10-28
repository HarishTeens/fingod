// Command fingod serves the API and, in a packaged build, the UI beside it.
//
//	FINGOD_DB_URL     postgres connection string   (required)
//	FINGOD_API_TOKEN  bearer token for /api/v1     (required)
//	FINGOD_ADDR       listen address               (default 127.0.0.1:8080)
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/harishteens/fingod/api/internal/httpapi"
	"github.com/harishteens/fingod/api/internal/store"
)

func main() {
	probe := flag.Bool("healthcheck", false, "probe the running server and exit (used by the container healthcheck)")
	flag.Parse()

	if *probe {
		os.Exit(healthcheck())
	}
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	dbURL, err := required("FINGOD_DB_URL")
	if err != nil {
		return err
	}
	token, err := required("FINGOD_API_TOKEN")
	if err != nil {
		return err
	}
	// The placeholder from .env.example must never reach a running server: it
	// is committed to the repo, so it is a published password.
	if token == "change-me" || len(token) < 16 {
		return errors.New("FINGOD_API_TOKEN is the placeholder or too short — run `make env`, or generate one with `openssl rand -hex 32`")
	}
	addr := envOr("FINGOD_ADDR", "127.0.0.1:8080")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(ctx, dbURL)
	if err != nil {
		return err
	}
	defer st.Close()

	// Migrating at startup means a fresh database — a new laptop, a cloud
	// deploy — comes up correct without a separate step anyone can forget.
	applied, err := st.Migrate(ctx)
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	if len(applied) > 0 {
		slog.Info("migrations applied", "versions", strings.Join(applied, ", "))
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           httpapi.New(st, token).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		slog.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}

// healthcheck is what the container probe runs: the image has no curl, and
// adding one to a scratch-ish alpine just to check a port would be silly.
func healthcheck() int {
	addr := envOr("FINGOD_ADDR", "127.0.0.1:8080")
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://" + addr + "/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "healthcheck: status", resp.StatusCode)
		return 1
	}
	return 0
}

func required(key string) (string, error) {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return "", fmt.Errorf("%s is not set — copy .env.example to .env (or run `make env`)", key)
	}
	return v, nil
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
