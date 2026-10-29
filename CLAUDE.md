# CLAUDE.md

Guidance for Claude Code (and any coding agent) working in this repository.

## What this is

fingod is a **local-first net worth and portfolio tracker that runs entirely in the browser**: vanilla
ES modules, SQLite compiled to WebAssembly (`sql.js`, vendored), no backend, no database server, no
build step, no npm dependencies. You clone it and run Python's built-in static server.

The browser cannot speak MCP, so **you** are the connector. The `/refresh` skill
(`.claude/skills/refresh/SKILL.md`) reads Wallet, Zerodha Kite and INDmoney over MCP and writes JSON files
into `data/`; the app imports them automatically. Read [docs/DATA-FORMAT.md](docs/DATA-FORMAT.md) before
writing any, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing `src/compute/`.

If a user asks you to "set up fingod", follow [docs/ONBOARDING.md](docs/ONBOARDING.md): onboarding is a short form in the
terminal (selectable questions, then a submit step), and the browser only shows the result. [PROMPT.md](PROMPT.md) is the prompt that points here.

## Hard rules

1. **Never place, modify or cancel an order.** The Kite MCP server exposes `place_order`, `modify_order`,
   `cancel_order` and GTT tools. This project only reads. If asked to trade, tell the user to use their
   broker directly.
2. **Never commit personal financial data.** That means real holdings, balances, transactions, account
   or employer names, tokens, exports, and screenshots of a real dashboard. Everything in `data/` except
   `data/README.md` is gitignored on purpose. Test fixtures, docs and demo data use invented values
   (`ACME`, `Example Bank`, round numbers).
3. **Money is exact.** Send `qty` and `price`, never a computed total; the app computes
   `value_inr = round(qty × price × fx_rate, 2)`. In `src/compute/`, round with `money()` and reconcile
   anything that must add up (see `qtydiff.reconcile`) instead of trusting float addition.
4. **Match holdings on ISIN**, not ticker. Tickers get renamed, and a rename must not read as a sale.
5. **Write only into `data/`.** Never write secrets (MCP tokens) into any file in the repo.

## Run, test, screenshot

```bash
python3 -m http.server 8000 --bind 127.0.0.1   # the standard library: nothing from this repo is run
open "http://localhost:8000/?demo"             # explore with invented data, no accounts needed
python3 serve.py                               # optional: the same, plus a manifest of data/, and it opens a browser
node --test                      # unit tests for the engine and the ingest validation (any Node 20+)
node scripts/screenshot.mjs "http://localhost:8000/?demo#/investments" out.png --full   # Node 22+, Chrome
```

There is nothing to install. Run a single test file with `node --test tests/compute.test.js` (a bare `node --test` finds them all; the `tests/` directory form breaks on Node 22+).

## Layout

```
index.html           app shell; loads vendor/sql-wasm.js, then src/main.js
serve.py             optional static server; lists data/ at /data/manifest.json (plain http.server works too)
vendor/              sql.js (SQLite → WebAssembly), MIT, committed as-is
src/main.js          boot, routing, the poll that imports new files
src/db.js            open the database, persist it to IndexedDB, query helpers
src/schema.js        the SQLite schema (versioned migrations)
src/ingest.js        validate and store checkpoints, transactions, manual entries, standing rows
src/repo.js          read models the UI draws from
src/compute/         pure functions: qty-diff, net worth, FD interest, returns, realised, expenses
src/ui/              one module per page, plus charts.js (SVG strings) and format.js
src/demo.js          invented demo dataset
src/prompts.js       the setup prompt and the coding agents we ship config for
src/ui/welcome.js    the empty state: how to start your agent, the demo, a file drop
tests/               node:test; no dependencies
docs/                DATA-FORMAT, ARCHITECTURE, MCP-SHAPES
landing/             the static landing page (deployed separately)
```

## Conventions

- **No build step, no dependencies.** Plain ES modules and CSS. Don't introduce a bundler, a framework or
  an npm dependency; vendor a single file if you truly need a library.
- `src/compute/` is pure and has tests. Keep it free of DOM and database access.
- Pages build HTML strings and **escape every interpolated value** with `esc()` from `ui/format.js`.
- Colours come from CSS variables in `src/styles/tokens.css`, consumed by role, never as raw hex.
- Source ownership is exclusive: Wallet owns cash, cards and expenses; Kite owns Indian equity and funds,
  Groww owns Indian equity held there (merged with Kite by ISIN); INDmoney owns US equity and EPF; manual input owns Bitcoin, fixed deposits and Splitwise. Discard the
  overlap rather than reconciling it.
- A source that fails is carried forward and marked `stale`, never written as zero.
- Credit cards are stored as a positive outstanding balance; Wallet reports them negative.
- Comments explain *why*, in the voice of the surrounding code. Match it.
- Schema changes: add a step to `MIGRATIONS` in `src/schema.js` and bump `SCHEMA_VERSION`. Never edit a
  shipped step.

## Keeping things in step

- The setup prompt exists in three places: `PROMPT.md`, `MASTER` in `src/prompts.js`, and
  `landing/prompt.md`. Change them together.
- `.claude/skills/refresh/SKILL.md` and `docs/MCP-SHAPES.md` describe the same mappings. Change them
  together.
- The MCP servers are declared once per agent, and the three must list the same servers and the same
  disabled Kite order tools: `.mcp.json` (Claude Code, with deny rules in `.claude/settings.json`),
  `.codex/config.toml` (Codex CLI) and `.gemini/settings.json` (Gemini CLI). `AGENTS.md` is the short
  guidance Codex and Gemini read; `CLAUDE.md` is the full version. The agent choices on the
  empty-state screen and on the landing page live in `AGENTS` in `src/prompts.js` and in the landing page's script.

## Screenshots

README and landing screenshots are rendered from `?demo` data with `scripts/screenshot.mjs`. Never
screenshot a dashboard that holds real data.
