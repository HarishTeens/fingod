# Setup

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Docker | any recent | Runs Postgres |
| Go | 1.24+ | The API |
| Node | 20.19+ or 22.12+ (see `.nvmrc`) | Vite 7 for the UI |
| Python | 3.9+ | Optional importers in `scripts/` |
| Claude Code | latest | Runs the `/refresh` routine |

If your default `node` is older than Vite needs, point the Makefile at a newer one:

```bash
make web NODE_BIN=$HOME/.nvm/versions/node/v24.0.0/bin
```

## 1. Run the stack

```bash
make env        # once — writes .env with freshly generated secrets
make up         # Postgres on 127.0.0.1:5432
make migrate    # apply the schema
make api        # Go API on :8080
make web-install && make web   # Vite dev server on :5173 (separate shell)
```

`make env` generates a database password and an API bearer token. Open `.env` and make
`FINGOD_DB_URL` match the generated `POSTGRES_PASSWORD`. `.env` is gitignored and `chmod 600`.

`make` on its own lists every command. `make up-tools` adds Adminer on :8081 for inspecting the
database, and `make up-all` runs the packaged stack. `make build` produces a single binary with the UI
embedded.

Everything binds to `127.0.0.1`. Every `/api/v1` route needs the bearer token; only `/healthz` is open.

```bash
source .env
curl -H "Authorization: Bearer $FINGOD_API_TOKEN" localhost:8080/api/v1/checkpoints
```

## 2. Connect the data sources

`.mcp.json` declares the MCP servers, scoped to this directory, so they load only for a Claude Code
session started here.

| Server | Transport | Auth |
|---|---|---|
| `wallet` | remote HTTP | Bearer token, or OAuth where supported |
| `kite` | `mcp-remote` bridge | Zerodha OAuth on first tool call |
| `indmoney` | remote HTTP | OAuth 2.1 + PKCE (mobile, OTP, MPIN) |

```bash
make claude        # launches Claude Code with .env loaded, so the Wallet token resolves
```

Approve the project's MCP servers when prompted, and complete each login in the browser. For Wallet,
generate a token in the app under Settings → MCP and put it in `.env` as `WALLET_MCP_TOKEN`. It must
be the **full token**: a malformed one is rejected with HTTP 401.

Wallet is capped at 300 requests an hour, shared with its REST API. `/refresh` therefore pulls only
transactions since the last checkpoint.

## 3. Take your first checkpoint

Inside Claude Code in this directory:

```
/refresh
```

The routine:

1. Calls `GET /api/v1/refresh-state` to learn what it needs.
2. Reads Wallet, Kite and INDmoney.
3. Asks you for what no server can supply, such as a Bitcoin quantity and value.
4. POSTs one checkpoint.
5. Reports net worth and what moved, **split into market, flow and FX**.

On a first run Wallet may list accounts fingod has not seen. The checkpoint is refused until each is
classified, because a fixed deposit looks identical to a salary account:

```bash
curl -X PATCH localhost:8080/api/v1/wallet-accounts/{id} \
  -H "Authorization: Bearer $FINGOD_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"role":"cash","role_note":"why"}'      # cash | credit_card | ignore
```

Take a checkpoint weekly, or whenever you want an answer. It never polls and it never places an order.

## 4. Standing rows

Fixed deposits and Splitwise are entered once and valued at every checkpoint.

```bash
# a fixed deposit
curl -X POST localhost:8080/api/v1/fixed-deposits -H "Authorization: Bearer $FINGOD_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"bank":"Example Bank","principal":"100000","rate_pct":"7.1","start_date":"2026-01-01","maturity_date":"2027-01-01"}'

# someone owes you ₹3,200 (negative if you owe them)
curl -X PUT localhost:8080/api/v1/splitwise/Friend -H "Authorization: Bearer $FINGOD_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"amount_inr":3200,"note":"Trip"}'
```

Set your target allocation with `PUT /api/v1/settings/target-allocation`. Percentages must total 100.

## 5. Optional: realised profit and cost basis

Neither broker exposes past orders over MCP, so realised profit and true US cost basis come from
exports you download yourself:

| Command | Input | Produces |
|---|---|---|
| `make import-tradebooks EXPORTS=<dir>` | Zerodha tradebook CSVs | Realised P&L, FIFO-matched |
| `make import-us-orders EXPORTS=<dir>` | INDmoney `IND-ORDER_REPORT*.xls` | True USD and INR cost basis for US holdings |
| `make import-orders EXPORTS=<dir>` | Both of the above | The full order tape |
| `make fetch-mf-navs` | Public AMFI data | Mutual fund NAV history |
| `make import-prices FILE=bars.json` | Daily bars | Price history for benchmarks |

Corporate actions such as demergers create units with no purchase. Copy
`scripts/opening-lots.example.json` to `scripts/opening-lots.json` and record them there, with where
each cost came from. That file is gitignored, along with the FX cache and your exports.

## Tests

```bash
make test        # Go tests
make web-smoke   # render every dashboard component against the live API
```

## Keeping your data private

The repository is meant to be shared; your data is not. Never commit `.env`, exports, the
`opening-lots.json` or `us-fx-rates.json` files, or screenshots of your own dashboard. The
screenshots in this repository were rendered from invented numbers.
