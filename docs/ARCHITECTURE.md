# Architecture

fingod is a local-first net worth and portfolio tracker. It assembles expenses, investments and
balances from several sources into one timeline of **checkpoints**, and derives growth by diffing
them.

```
Claude Code — /refresh
   ├─ Wallet MCP      → expense transactions, cash, credit cards
   ├─ Kite MCP        → Indian equity, Indian mutual funds
   ├─ INDmoney MCP    → US equity, EPF, US wallet cash
   └─ prompts you     → Bitcoin, FDs, Splitwise
                    └──► POST /api/v1/checkpoints ──► Postgres ──► React UI
```

Three tiers, all on your machine:

| Tier | Tech | Notes |
|---|---|---|
| Database | Postgres 17 in Docker | System of record. Plain SQL migrations, exact `NUMERIC` money. |
| API | Go, `gorilla/mux`, `pgx` | One binary. Embeds the built UI for packaged runs. |
| UI | React 19, Vite 7, Recharts 3 | Dark by default, with a light theme. |

## The core idea: a checkpoint, not a feed

A **checkpoint** is an immutable snapshot of every position on one date, taken weekly or on demand.
Nothing polls. Growth is never read from a price feed; it is derived by diffing consecutive
checkpoints and watching **quantity**. A ₹50k SIP therefore never masquerades as ₹50k of market gain.

### The qty-diff engine

For each holding between a previous checkpoint `p` and a new one `n`:

```
market =  qty_p × (price_n − price_p) × fx_n     ← real gain or loss
flow   = (qty_n − qty_p) × price_n   × fx_n      ← money added or withdrawn
fx     =  qty_p ×  price_p × (fx_n − fx_p)       ← currency effect (0 for INR holdings)
```

These sum **exactly** to `value_n − value_p`. It is an algebraic identity, not an approximation:

```
qₙpₙfₙ − qₚpₚfₚ  ≡  qₚ(pₙ−pₚ)fₙ + (qₙ−qₚ)pₙfₙ + qₚpₚ(fₙ−fₚ)
```

The third term matters: without it a rupee move on US holdings would be booked as market gain.
Sleeve-level figures are the sum over holdings. The code is in `api/internal/compute/qtydiff.go` and
the identity is property-tested in `qtydiff_test.go`.

Edge cases the engine handles:

- **New symbol** (`qty_p = 0`) is all flow, zero market.
- **Fully exited** (`qty_n = 0`) is a negative flow at the current price, so a sale is never booked
  as a total loss.
- **Ticker renames** would read as a full exit plus a full entry. Holdings are therefore matched on
  **ISIN**, which survives renames, falling back to sleeve + symbol only when an ISIN is absent.
- **Splits and bonus issues** raise quantity with no money in. Any single-holding flow above 25% of
  its sleeve is flagged for review.
- **FDs and EPF have no quantity.** FD growth is computed interest. EPF is reported as one change and
  never split into contribution versus interest, because the source does not separate them.

### Send quantity and price, never a total

`value_inr` is computed in Postgres `NUMERIC` as `round(qty × price × fx_rate, 2)`. A client may send
the source's own total, which is cross-checked; a disagreement over ₹1 comes back in `warnings`.
US holdings carry their native USD price, and the rate is recovered from the source's own INR and USD
figures so the identity stays exact. An external FX quote would break it.

## Sleeves

Each holding belongs to exactly one sleeve:

| Sleeve | What | Owned by |
|---|---|---|
| `in_equity` | Indian stocks and ETFs | Kite |
| `in_mf` | Indian mutual funds | Kite |
| `us_equity` | US stocks | INDmoney |
| `gold` | Gold ETFs | Kite (classified by ISIN) |
| `debt` | Overnight and liquid ETFs | Kite (classified by ISIN) |
| `btc` | Bitcoin | manual |
| `fd` | Fixed deposits | standing rows, valued by formula |

Classification is by ISIN, not ticker, because tickers get renamed.

## Source ownership

Exclusive by design. Two sources often report the same asset and disagree, so ingest discards the
overlap rather than reconciling it:

```
Wallet    → expenses, cash, credit cards      (its FD accounts are excluded)
Kite      → Indian equity, Indian mutual funds, idle broker cash
INDmoney  → US equity, EPF, US wallet cash    (everything else discarded)
Manual    → Bitcoin, fixed deposits, Splitwise
```

See [MCP-SHAPES.md](MCP-SHAPES.md) for why each source owns what it owns.

## Two net worth numbers

```
NW_liquid = cash + IN equity + IN MF + US equity + BTC + FD principal − credit card outstanding
NW_total  = NW_liquid + EPF + FD accrued interest + Splitwise receivable
```

Liquid is what you could act on. Total is what you are worth on paper. Both are stored at every
checkpoint. `api/internal/compute/networth.go` computes them and the tests prove the two differ by
exactly the illiquid part.

## Standing rows

Some things change rarely, so they are entered once and valued at every checkpoint:

- **Fixed deposits** store principal, rate, start and maturity. Value at any date is computed, so a
  deposit entered today is priced correctly at checkpoints taken before it existed. Close one with
  `closed_at` rather than deleting it, or history silently rewrites itself.
- **Splitwise** keeps only the bottom line per person. Positive means they owe you.

## Data model

Defined in `api/migrations/` (plain SQL, applied in order and tracked in `schema_migrations`):

| Table | Purpose |
|---|---|
| `checkpoints` | One row per snapshot date, with the USD/INR rate and per-source status |
| `holdings` | Positions at a checkpoint: sleeve, symbol, ISIN, qty, price, fx, value, cost basis |
| `balances` | Cash, credit cards, EPF and Splitwise at a checkpoint |
| `fixed_deposits`, `splitwise_balances` | Standing rows |
| `wallet_accounts` | Every Wallet account and the role you gave it (`cash`, `credit_card`, `ignore`) |
| `transactions` | Wallet records, idempotent on Wallet's own id |
| `trades`, `price_targets` | Realised profit and the targets that produce it |
| `orders` | The broker order tape, used to derive cost basis |
| `us_cost_basis` | True rupee cost for US holdings, FIFO'd at each buy date's own FX rate |
| `price_history`, `benchmarks`, `fx_rates` | Daily bars, the indices the portfolio is compared against, and FX rates |
| `corporate_actions`, `transaction_labels` | Adjustments that neutralise splits and bonuses; labels on Wallet records |
| `settings` | Target allocation and a few thresholds |

## Expenses

Wallet transactions feed the expense views. A few rules keep the charts honest:

- **Investments are not spend.** SIP money is filed as an expense in Wallet; folding it in would make
  the chart a picture of SIP dates, so it is kept apart.
- **Transfers between your own accounts are excluded**, including ones whose mirror record was lost.
- **Money that came back is subtracted** from the label it came back under, so a bar shows what
  something cost you, not what passed through your account. A label that nets negative is clamped to
  zero and the clamped amount is reported rather than dropped.
- Spend is bucketed by week or month and drillable by label, category, subcategory and transaction.

## Performance and realised profit

- **Unrealised** return is current value against cost basis. A group with any missing cost basis is
  marked `partial` instead of reporting a flattering number.
- **Realised** profit comes from the order tape, FIFO-matched, and is bucketed on the **exit** date.
  Break-even counts as a loser. Gross wins and gross losses are shown separately so they never net
  off into a misleading total.
- **Disposals** are detected by diffing checkpoints: a quantity that fell is a sale. The sale price is
  the one thing a snapshot cannot know, so it is estimated at the previous price and confirmed by you.
- **Indexed performance** puts every sleeve on one axis starting at 100, so a large sleeve and a small
  one are comparable by rate of change.
- **Targets** are arithmetic on prices you chose, not a forecast.

## API

Every `/api/v1` route needs the bearer token from `.env`. Only `/healthz` is open. The main groups:

| Route | What |
|---|---|
| `POST/GET /checkpoints[/{date}]` | Ingest and read snapshots (201 new, 200 replaced, idempotent on date) |
| `GET /networth`, `/allocation`, `/sleeves`, `/compare` | Dashboard views |
| `GET /expenses`, `/expenses/breakdown`, `/expenses/transactions` | Spend views |
| `POST /transactions` | Bulk upsert of Wallet records |
| `GET/PATCH /wallet-accounts` | Classify accounts |
| `GET/POST/PUT/DELETE /fixed-deposits`, `/splitwise` | Standing rows |
| `GET /disposals`, `POST /trades`, `GET /realised` | Sales and realised profit |
| `GET/PUT /price-targets`, `GET /projection` | Targets |
| `GET /refresh-state` | Everything `/refresh` needs before it touches an MCP server |

A checkpoint POST returns **409** and writes nothing if Wallet shows an account that has never been
classified. A fixed deposit is typed `General`, identical to a salary account, so it is classified by
hand once rather than guessed.

## Layout

| Path | What |
|---|---|
| `api/cmd/fingod` | Entry point |
| `api/internal/compute` | qty-diff, net worth, FD interest, performance. Where correctness lives. |
| `api/internal/domain` | Types, validation, exact decimal handling |
| `api/internal/store` | Postgres queries |
| `api/internal/httpapi` | Routes and handlers |
| `api/migrations` | SQL schema, embedded into the binary |
| `web/src` | React UI |
| `scripts` | Importers for broker exports |
| `.claude/skills/refresh` | The `/refresh` routine |
| `landing` | Static landing page |

## Known limits

- Weekly checkpoints mean weekly resolution. A stock bought and sold between two checkpoints is
  invisible, and a week with both a sale and a purchase of the same stock nets to one disposal.
- Sources can lag. A source that fails is carried forward and marked `stale`, and a stale sleeve is
  excluded from that period's attribution rather than booked as a crash to zero.
- EPF contribution and interest cannot be separated.
- Wallet balances that are not bank-synced are running totals of manual entries and can drift from the
  real bank balance. The drift is carried, not corrected here.
