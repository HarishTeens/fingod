# Architecture

fingod is a local-first net worth and portfolio tracker. It is a **static web app**: vanilla ES modules
and SQLite compiled to WebAssembly, running entirely in your browser. There is no backend, no database
server and no build step.

```
Your coding agent (Claude Code, etc.)
   ├─ Wallet MCP      → expense transactions, cash, credit cards
   ├─ Kite MCP        → Indian equity, Indian mutual funds
   ├─ Groww MCP       → Indian equity (a second broker)
   ├─ INDmoney MCP    → US equity, EPF
   └─ asks you        → Bitcoin
        └──► writes JSON into data/  ──►  a local server lists it  ──►  the browser imports it into SQLite
                                                                        └──► dashboard
```

| Piece | What |
|---|---|
| `index.html` + `src/` | The app: ES modules loaded natively, no bundler |
| `vendor/sql-wasm.*` | [sql.js](https://github.com/sql-js/sql.js): SQLite compiled to WebAssembly (MIT) |
| IndexedDB | Where the database file is persisted between visits |
| a local static server | `python3 -m http.server` is enough; the app reads `data/` from its directory listings. `serve.py` is an optional variant that adds `/data/manifest.json` |
| `data/` | The hand-off folder between your agent and the browser. Gitignored. |

**Why a hand-off folder?** Browsers cannot speak MCP, and your broker credentials should never touch a
web page. Your agent, running on your machine, does the connecting, and the only thing that crosses into
the app is plain JSON. See [DATA-FORMAT.md](DATA-FORMAT.md).

## The core idea: a checkpoint, not a feed

A **checkpoint** is an immutable snapshot of every position on one date, taken weekly or on demand.
Nothing polls. Growth is never read from a price feed; it is derived by diffing consecutive checkpoints
and watching **quantity**. A ₹50k SIP therefore never masquerades as ₹50k of market gain.

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

The third term matters: without it a rupee move on US holdings would be booked as market gain. Sleeve
figures are the sum over holdings. The code is `src/compute/qtydiff.js`; the identity is tested over
thousands of random inputs in `tests/compute.test.js`.

Edge cases the engine handles:

- **New symbol** (`qty_p = 0`) is all flow, zero market.
- **Fully exited** (`qty_n = 0`) is a negative flow at the last known price, so a sale is never booked as
  a crash to zero.
- **Ticker renames** would read as a full exit plus a full entry. Holdings are matched on **ISIN**, which
  survives renames, falling back to sleeve + symbol only when an ISIN is absent.
- **Splits and bonus issues** raise quantity with no money in. Any single-holding flow above 25% of its
  sleeve is flagged for review.
- **FDs and EPF have no quantity.** FD growth is computed interest. EPF is one balance per employer and
  is never split into contribution versus interest, because the source does not separate them.

### Send quantity and price, never a total

`value_inr` is computed on import as `round(qty × price × fx_rate, 2)`. A source may send its own total,
which is cross-checked; a disagreement over ₹1 is reported as a warning. US holdings carry their native
USD price, and the rate is recovered from the source's own INR and USD figures, so the identity stays
exact. An external FX quote would break it.

## Sleeves

Each holding belongs to exactly one sleeve:

| Sleeve | What | Owned by |
|---|---|---|
| `in_equity` | Indian stocks and ETFs | Kite, and Groww (merged by ISIN) |
| `in_mf` | Indian mutual funds | Kite |
| `us_equity` | US stocks | INDmoney |
| `gold` | Gold ETFs | Kite (classified by ISIN) |
| `debt` | Overnight and liquid ETFs | Kite (classified by ISIN) |
| `btc` | Bitcoin | manual |
| `fd` | Fixed deposits | standing rows, valued by formula |

## Source ownership

Exclusive by design. Two sources often report the same asset and disagree, so import discards the
overlap rather than reconciling it:

```
Wallet    → expenses, cash, credit cards      (its FD accounts are excluded)
Kite      → Indian equity, Indian mutual funds, idle broker cash
Groww     → Indian equity held at Groww (merged with Kite by ISIN; mutual funds not supported yet)
INDmoney  → US equity, EPF, US wallet cash    (everything else discarded)
Manual    → Bitcoin, fixed deposits, Splitwise
```

See [MCP-SHAPES.md](MCP-SHAPES.md) for why each source owns what it owns.

## Two net worth numbers

```
NW_liquid = cash + IN equity + IN MF + US equity + BTC + FD principal − credit card outstanding
NW_total  = NW_liquid + EPF + FD accrued interest + Splitwise receivable
```

Liquid is what you could act on. Total is what you are worth on paper. Both are computed at every
checkpoint (`src/compute/networth.js`), and the tests prove the two differ by exactly the illiquid part.

## Standing rows

Some things change rarely, so they are entered once in the app and valued at every checkpoint:

- **Fixed deposits** store principal, rate, start and maturity. Value at any date is computed, so a
  deposit entered today is priced correctly at checkpoints taken before it existed. Close one with a
  closing date rather than deleting it, or history silently rewrites itself.
- **Splitwise** keeps only the bottom line per person (positive means they owe you), snapshotted into
  each checkpoint so history keeps what was true at the time.
- **Bitcoin** is a hand-entered quantity and value, carried forward into later checkpoints.

## Data model

The schema is in `src/schema.js` (versioned migrations, applied on open):

| Table | Purpose |
|---|---|
| `checkpoints` | One row per snapshot date, with the USD/INR rate and per-source status |
| `holdings` | Positions at a checkpoint: sleeve, symbol, ISIN, qty, price, fx, value, cost basis |
| `balances` | Cash, credit cards, EPF and Splitwise at a checkpoint |
| `fixed_deposits`, `splitwise_balances`, `manual_holdings` | Standing and hand-entered rows |
| `transactions`, `transaction_labels`, `wallet_accounts` | Wallet records, idempotent on Wallet's own id |
| `trades` | Realised profit you confirmed |
| `settings` | Target allocation, your agent choice |
| `imported_files` | Which files from `data/` were imported, so syncing twice is a no-op |

The database file is exported to IndexedDB after every write. **Data → Download backup** saves it as a
`.sqlite` file you can restore anywhere.

## Expenses

Wallet transactions feed the expense views (`src/compute/expenses.js`). A few rules keep the charts
honest:

- **Investments are not spend.** SIP money is filed as an expense in Wallet; folding it in would make the
  chart a picture of SIP dates, so it is excluded.
- **Transfers between your own accounts are excluded**, including ones whose mirror record was lost
  (they sit in Wallet's Transfer category).
- **Money that came back is subtracted** from the label it came back under, so a bar shows what
  something cost you, not what passed through your account. Income counts only if it carries a label:
  your salary is untagged. A label that nets negative is clamped to zero and the clamped amount is
  reported rather than dropped.
- **Labels are many-to-many.** A modifier label (how it was paid, such as `Split`) steps aside when a
  record has any other label; what is left shares the amount evenly, so the parts still sum to the whole.

## Performance and realised profit

- **Unrealised** return is current value against cost basis. A group with any missing cost basis is
  marked `partial` instead of reporting a flattering number.
- **Indexed performance** is **time-weighted**: each period chains `(market + fx) / opening value` and
  leaves flow out, so a SIP never reads as a gain and a sale never reads as a crash.
- **Disposals** are detected by diffing checkpoints: a quantity that fell is a sale. The sale price is the
  one thing a snapshot cannot know, so proceeds are estimated at the previous price and confirmed by you
  before they are recorded.
- **Realised** profit is bucketed on the **exit** date. Break-even counts as a loser, and gross wins and
  gross losses are shown separately so they never net off into a misleading total.

## Known limits

- Weekly checkpoints mean weekly resolution. A stock bought and sold between two checkpoints is
  invisible, and a week with both a sale and a purchase of the same stock nets to one disposal.
- A source that fails is carried forward and marked `stale`; a stale sleeve is excluded from that
  period's attribution rather than booked as a crash to zero.
- EPF contribution and interest cannot be separated.
- Wallet balances that are not bank-synced are running totals of manual entries and can drift from the
  real bank balance. The drift is carried, not corrected here.
- The database lives in browser storage. Clearing site data erases it, so keep a backup.
- Needs a modern browser (Chrome, Edge, Safari, Firefox) and Python 3 for its built-in static server.
