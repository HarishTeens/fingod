# fingod

**One view of everything you own, running on your own machine.**

fingod assembles your expenses, investments and balances from Wallet, Zerodha, INDmoney and a few
manual figures into a single timeline of weekly **checkpoints**. It then tells you what actually
grew and what you simply added, so a ₹50k SIP never masquerades as ₹50k of market gain.

![fingod dashboard: net worth, allocation and monthly spend by label](landing/shots/dash.png)

<sub>Rendered from invented numbers. No real data is shown anywhere in this repository.</sub>

## Features

- **Net worth, two ways.** *Liquid* is what you could act on; *total* adds EPF, accrued FD interest and
  Splitwise receivables. Both are stored at every checkpoint, back to your first.
- **Growth, split honestly.** Every change between checkpoints is separated into **market**, **flow**
  (money you added or withdrew) and **FX**. The three sum exactly to the change.
- **Performance across sleeves.** Indian equity, mutual funds, US equity, gold, debt and Bitcoin on one
  axis indexed to 100, with returns against true cost basis.
- **Allocation against targets.** Set a target per sleeve and see the drift after each checkpoint.
- **Realised profit.** Sales are detected by diffing checkpoints; win rate, holding period and gross
  wins versus losses are tracked, bucketed on the exit date.
- **Expenses you can drill into.** Weekly or monthly spend by label, down through category to the single
  transaction, net of money that came back.
- **A 52-week price watch** on every refresh, for mega-cap US stocks and your gold ETF.
- **Local-first and read-only.** Postgres on `127.0.0.1`, a bearer token on every route, and a refresh
  routine that can never place an order.

![fingod investments: every sleeve indexed to 100, with market, flow and FX](landing/shots/inv.png)

## How it works

```
Claude Code — /refresh
   ├─ Wallet MCP      → expense transactions, cash, credit cards
   ├─ Kite MCP        → Indian equity, Indian mutual funds
   ├─ INDmoney MCP    → US equity, EPF
   └─ prompts you     → Bitcoin (CoinDCX has no MCP), FDs, Splitwise
                    └──► POST /api/v1/checkpoints ──► Postgres ──► React UI
```

A checkpoint is an immutable snapshot of every position on one date. Nothing polls. Growth is derived
by diffing consecutive checkpoints and watching **quantity**:

```
market =  qty_prev × (price_now − price_prev) × fx_now
flow   = (qty_now − qty_prev) × price_now × fx_now
fx     =  qty_prev × price_prev × (fx_now − fx_prev)
```

Those three terms sum to the change in value as an algebraic identity, not an approximation. Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

Each source owns exactly one set of assets, because overlapping sources disagree and reconciling them
only hides which one is wrong:

| Source | Owns |
|---|---|
| Wallet | expenses, cash, credit cards |
| Zerodha Kite | Indian equity, mutual funds, gold and liquid ETFs |
| INDmoney | US equity, EPF |
| Manual | Bitcoin, fixed deposits, Splitwise |

## Quick start

```bash
make env        # once — generates .env with fresh secrets
make up         # Postgres on 127.0.0.1:5432
make migrate    # apply the schema
make api        # Go API on :8080
make web        # Vite dev server on :5173 (separate shell)
```

Want to look around first? **`make demo`** runs the dashboard on invented data, with no accounts,
database or API needed.

Then connect your sources and take a checkpoint. [docs/SETUP.md](docs/SETUP.md) covers the MCP servers,
classifying Wallet accounts and the optional importers. Inside Claude Code in this directory:

```
/refresh
```

`make` on its own lists every command. Requirements are Docker, Go 1.24+, Node 20.19+ and Claude Code.

## Documentation

| Doc | What |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | Install, connect sources, take a first checkpoint, importers |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The qty-diff engine, sleeves, net worth, data model, API |
| [docs/MCP-SHAPES.md](docs/MCP-SHAPES.md) | What each MCP server returns and how it maps to a checkpoint |
| [CLAUDE.md](CLAUDE.md) | Guidance for Claude Code working in this repo |
| [`.claude/skills/refresh`](.claude/skills/refresh/SKILL.md) | The `/refresh` routine |
| [`landing/`](landing/index.html) | A static landing page for the project |

## Layout

| Path | What |
|---|---|
| `api/` | Go API: `compute/` (where correctness lives), `domain/`, `store/`, `httpapi/`, SQL `migrations/` |
| `web/` | React 19 + Vite 7 + Recharts 3 |
| `scripts/` | Importers for broker exports |
| `docker-compose.yml`, `Dockerfile` | Postgres, Adminer, and a packaged single-binary image |

## Security and privacy

- Every container binds to `127.0.0.1`. Every `/api/v1` route needs a bearer token; only `/healthz` is
  open.
- `.env` holds the database password, the API token and optionally a Wallet token. It is gitignored.
- The refresh routine is read-only. It never calls `place_order`, `modify_order`, `cancel_order` or the
  GTT equivalents.
- Your data lives in your own Postgres. Exports, the FX cache and `opening-lots.json` are gitignored.
  Don't commit them, and don't commit screenshots of your own dashboard.

## Tests

```bash
make test        # Go tests, including property tests of the qty-diff identity
make web-smoke   # render every dashboard component against a live API
```

## License

Licensed under the [Apache License 2.0](LICENSE). Use it, change it and ship it as you like; the
license asks only that you keep the notice and say what you changed. It comes with no warranty, and
nothing here is financial advice.
