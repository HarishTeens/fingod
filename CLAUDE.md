# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

fingod is a local-first net worth and portfolio tracker. Claude Code's `/refresh` skill reads Wallet,
Zerodha Kite and INDmoney over MCP, asks for the few figures no server can supply, and POSTs one
**checkpoint** to a Go API backed by Postgres. A React UI shows the result. Growth is derived by
diffing consecutive checkpoints, never read from a price feed.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing anything under `api/internal/compute`.

## Hard rules

1. **Never place, modify or cancel an order.** The Kite MCP server exposes `place_order`,
   `modify_order`, `cancel_order` and GTT tools. This project only reads. If asked to trade, tell the
   user to use their broker directly.
2. **Never commit personal financial data.** That means real holdings, balances, transactions,
   account or employer names, tokens, exports, and screenshots of a real dashboard. Test fixtures and
   docs use invented values (`ACME`, `Example Bank`, round numbers). `.env`, `scripts/opening-lots.json`,
   `scripts/us-fx-rates.json`, spreadsheets and tradebook CSVs are gitignored on purpose.
3. **Money is exact.** Use `domain.Num` (a string-backed decimal) and Postgres `NUMERIC`. Never
   `float64` for money. `value_inr` is computed in the database as `round(qty × price × fx_rate, 2)`;
   clients send `qty` and `price`, never a total.
4. **Match holdings on ISIN**, not ticker. Tickers get renamed, and a rename must not read as a sale.
5. **Do not make migrations destructive.** They are plain SQL in `api/migrations/`, applied in order.
   Add a new numbered file rather than editing an applied one.

## Commands

```bash
make env && make up && make migrate   # first-time setup
make api                              # Go API on :8080
make web                              # Vite dev server on :5173 (needs Node >= 20.19, see .nvmrc)
make test                             # Go tests
make web-smoke                        # render every dashboard component against the live API
make claude                           # launch Claude Code with .env loaded
make                                  # list everything
```

Single Go test: `cd api && go test ./internal/compute -run TestName -count=1`.

## Layout

- `api/internal/compute` — the qty-diff engine, net worth, FD interest, performance. Where correctness
  lives; keep it pure and well tested.
- `api/internal/domain` — types, validation, decimal handling.
- `api/internal/store` — Postgres queries. `api/internal/httpapi` — routes and handlers.
- `web/src` — React 19 + Vite 7 + Recharts. Design tokens are in `web/src/styles/tokens.css` and are
  consumed by role, never as raw hex in components.
- `.claude/skills/refresh/SKILL.md` — the refresh routine. Keep it in step with `docs/MCP-SHAPES.md`.
- `landing/` — a static landing page and its screenshots.

## Conventions

- Source ownership is exclusive: Wallet owns cash, cards and expenses; Kite owns Indian equity and
  funds; INDmoney owns US equity and EPF; manual input owns Bitcoin, fixed deposits and Splitwise.
  Discard overlap rather than reconciling it.
- A source that fails is carried forward and marked `stale`, never written as zero.
- Credit cards are stored as a positive outstanding balance; Wallet reports them negative.
- Comments explain *why*, in the voice of the surrounding code. Match it.
- Tests that assert on money use round, invented numbers so the arithmetic can be checked by hand.

## Screenshots

To regenerate the dashboard screenshots without exposing real data, point the Vite proxy at a mock
API serving invented numbers (`FINGOD_API_ORIGIN=http://127.0.0.1:<port>`) and capture with headless
Chrome. Never screenshot a dashboard backed by a real database.
