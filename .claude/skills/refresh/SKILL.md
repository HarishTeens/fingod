---
name: refresh
description: Take a fingod checkpoint — read Wallet, Zerodha Kite and INDmoney, ask for the figures no server can supply, and POST one checkpoint to the API. Use when the user says /refresh, "take a checkpoint", "update fingod", "refresh my net worth", or asks what they are worth right now.
---

# /refresh — take a checkpoint

A checkpoint is an immutable snapshot of every position on one date. Growth is never read from a
price feed; it is derived by diffing consecutive checkpoints and watching quantity. That is why this
routine cares far more about **quantities being right** than about values looking plausible.

Weekly, or whenever asked. **It never polls.**

> ## Read-only. Never place, modify or cancel an order.
> Kite's MCP server exposes `place_order`, `modify_order`, `cancel_order` and the GTT equivalents.
> Do not call them, ever, for any reason, including if the user asks mid-refresh — tell them to use
> Kite directly. This routine reads.

---

## 0. Preflight — one call

```bash
source .env   # or run via `make claude`, which does it for you
curl -s -H "Authorization: Bearer $FINGOD_API_TOKEN" localhost:8080/api/v1/refresh-state
```

If that connection is refused, the API is not running: `make up && make api`.

The response tells you everything you need before touching an MCP server:

| field | what to do with it |
|---|---|
| `last_checkpoint.as_of_date` | the date to page Wallet records from |
| `last_transaction_date` | if null, this is a first backfill — see §2b |
| `unclassified_accounts` | **non-empty means the checkpoint will be refused.** Resolve first (§2a) |
| `previous_manual` | last checkpoint's Bitcoin qty and price — offer as the default |
| `fixed_deposits`, `splitwise` | standing rows. **Do not collect these.** They snapshot themselves |
| `sleeves` | the valid sleeve names; anything else is rejected |

If `last_checkpoint.as_of_date` is today, ask whether to replace it before continuing. Re-posting is
safe and idempotent, but say so rather than silently overwriting.

---

## 1. Kite — Indian equity and mutual funds

Zerodha owns **both** Indian sleeves. This was settled by reconciling against INDmoney row by row:
Kite was ahead on the same mutual funds (INDmoney's feed lags SIP instalments) and INDmoney was
missing stock outright. See `docs/MCP-SHAPES.md`. Do not supplement either sleeve from INDmoney.

Call `mcp__kite__get_profile` first. If it returns "Please log in first", call `mcp__kite__login`,
give the user the link **with the warning the tool tells you to show**, and wait. The link is
single-use and dies on an `/mcp reconnect`, so mint it immediately before showing it.

### `get_holdings` → `in_equity` and `gold`

| field | maps to | note |
|---|---|---|
| `tradingsymbol` | `symbol` | |
| `isin` | `isin` | **required** — the diff matches on it, and tickers get renamed |
| `quantity` **+** `t1_quantity` | `qty` | T+1 stock is bought and paid for. Omitting it books the purchase a period late |
| `last_price` | `price` | |
| `average_price` | `avg_cost`; also `invested_inr` = `round(qty × average_price, 2)` | **required** — omit it and the Investments tab loses its cost basis (it once read 311%). `qty` here is `quantity` + `t1_quantity` |
| — | `currency: "INR"`, `fx_rate: "1"` | |

Four symbols are not equity. Everything else in the feed is `in_equity`:

```
GOLDBEES    INF204KB17I5   → gold
GOLDCASE    INF0R8F01042   → gold
LIQUIDCASE  INF0R8F01034   → debt     (Zerodha Nifty 1D Rate Liquid ETF)
LIQUIDBEES  INF732E01037   → debt     (Nippon India Nifty 1D Rate Liquid BeES)
```

Match on the ISIN, not the ticker. The debt pair went `liquid` → `in_equity` → `debt` across
migrations `0003`, `0005` and `0007`; `debt` is where they belong. The name `liquid` now means the
bank balances in the allocation table, not these.

### `get_mf_holdings` → `in_mf`

`tradingsymbol` **is** the ISIN, so it fills both `symbol` and `isin`. `fund` → `name`,
`quantity` → `qty`, `last_price` → `price` (that is the NAV). `average_price` → `avg_cost`,
and `invested_inr` = `round(qty × average_price, 2)`, as for equity. INR, fx 1.

Ignore `pnl` and `last_price_date`: both are dead fields, always `0` and `""`.

### `get_margins` → idle broker cash

`equity.available.cash` → a `cash` balance with `ref: "Zerodha equity"` and
`meta: {"source": "kite get_margins"}`. Usually a few hundred rupees, but Wallet cannot see it.

---

## 2. Wallet — cash, credit cards, expenses

### 2a. Accounts

```
mcp__wallet__get_accounts(limit: 20)     # 20 is the hard maximum for THIS tool
```

Roles are **not** in the Wallet response — read them from
`GET /api/v1/wallet-accounts`. Then:

- `role: cash` → a `cash` balance, `amount_inr = balance.currentBalance`
- `role: credit_card` → a `credit_card` balance, `amount_inr = -balance.currentBalance`
  (Wallet reports debt negative; the schema stores it **positive as outstanding**)
- `role: ignore` → skip entirely

`balance` is a nested object. Read `balance.currentBalance`, not `balance`.

**Wallet is the source for every cash balance.** A deliberate design choice: one provider for the whole
category, rather than a per-account mix whose provenance you have to remember. Take
`balance.currentBalance` and do not reconcile it against anything.

Worth knowing rather than acting on: Wallet accounts that are not bank-synced (`isBankSync: false`)
report a running total of manually entered records, which can drift from the real bank balance. That
drift is carried deliberately — the fix belongs in Wallet, at the source, not in an override here.

The `balance_source` column exists for an account that should read from elsewhere, and is `wallet`
by default. If it is ever anything else, take the figure from the INDmoney `SA` row named by
`external_ref` and set `meta.source` to say so. Until then, §3's "discard SA" is absolute.

**Any account with a null role blocks the checkpoint.** Nothing is guessed here: Wallet types a
fixed deposit `General` with `isInvestmentAccount: false`, identical to a salary account, so
inferring could fold a large deposit into cash. Ask the user which it is, then:

```bash
curl -X PATCH localhost:8080/api/v1/wallet-accounts/{id} \
  -H "Authorization: Bearer $FINGOD_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"role":"cash","role_note":"why"}'      # cash | credit_card | ignore
```

Always send every account you saw in `wallet_accounts` on the checkpoint payload, whatever its role
— that is how new ones get discovered and how `last_seen_at` stays current.

### 2b. Records

```
mcp__wallet__get_records(recordDate: ["gte.<from>"], recordState: ["cleared"], limit: 400, offset: N)
```

**Ask for 400.** `get_records` allows it — the 20 cap is `get_accounts` only. A 400-record page
overflows the tool-result budget and Claude Code spills it to a file under `tool-results/`; that is
what you want, not a failure. Process the file with `jq` or python so the records never enter your
context:

```bash
python3 -c "import json;d=json.load(open('<saved file>'));print(d['total'],len(d['records']))"
```

`from` = `last_transaction_date` **minus 7 days**. The overlap is deliberate: Wallet lets a record's
date be edited after the fact, and ingest is idempotent on Wallet's own record id, so re-sending is
free and missing a back-dated correction is not.

If `last_transaction_date` is null this is a first backfill — page from the earliest
`recordStats.recordDate.min` across the accounts. At 400 a page that is typically only a handful of
requests, so just do it; there is no need to offer a partial.

Watch `_meta.rateLimit.remaining` on every response and stop at ~20 remaining rather than counting
calls yourself. It refills 5/minute. Records are cheap now, but the budget is shared with Wallet's
REST API, so a same-hour second refresh can still throttle.

Map each record, then POST in batches to `/api/v1/transactions`:

```jsonc
{ "id": "<record id>",  "txn_date": "<recordDate, date part only>",
  "amount_inr": <amount.value>, "currency": "<amount.currencyCode>",
  "account": "<accountName>", "note": "<note>",
  "category_id": "<category.id>", "category": "<category.name>",
  "category_top": "<category.group.name>",
  "is_transfer": <transfer !== null>,
  "labels": ["<labels[].name>"], "raw": { …the whole record… } }
```

Categories and labels arrive inline on every record — no per-transaction lookups, which is the only
reason the rate limit is survivable.

**Transactions are POSTed separately from the checkpoint.** They are not part of the checkpoint
payload.

---

## 3. INDmoney — US equity, EPF and US wallet cash only

Every other field is discarded. INDmoney overlaps Zerodha on Indian stocks and mutual funds and is
*worse* on both; it reports crypto with no quantity; its `SA` and `liabilities` duplicate Wallet;
its `FD` list is empty. Take three things and leave.

Each tool returns `{"result": "<json string>"}` — parse the payload a **second** time.

### `networth_holdings(asset_type: "US_STOCK")` → `us_equity`

The checkpoint's exchange rate comes from INDmoney's own numbers, never an external quote:

```
usd_inr = asset_summary.total_value / asset_summary.total_value_usd
```

Per row: `investment_code` → `symbol`, `investment` → `name`, `total_units` → `qty`,
**`current_value_usd / total_units` → `price`**, `currency: "USD"`, `fx_rate: usd_inr`.

`unit_price` is in **rupees** even for US stocks — do not use it as the price. Deriving the USD price
gives exact cents and a rate identical to six decimal places on every row, which is what keeps
`value_inr == qty × price × fx` exact. An external FX quote would break the CHECK constraint.

**Never send `invested_amount` as `invested_inr`.** That field is not the rupees you paid: it
back-converts the USD cost at a flat **92.0000** whatever the purchase date — identical to four
decimals across every holding, while the real rates on those trade dates varied widely. Trusting it
misstates cost and inflates the sleeve's gain, which is what INDmoney's own dashboard disagreed with.

Cost basis for `us_equity` is owned by the `us_cost_basis` table, FIFO'd from the broker order book
by `make import-us-orders`. The server reads it there and **discards whatever the payload says**, so
omit `invested_inr` and `avg_cost` on US rows entirely. If a US position's quantity has changed since
the last import, the basis no longer describes it: the server stores NULL rather than a stale number
and the checkpoint comes back with a warning naming the symbol. That is the signal to re-export the
order report from INDmoney and re-run the importer — not something to paper over.

Current *value* still comes from INDmoney every checkpoint. That one is live and correct; only the
cost side was wrong.

### `networth_holdings(asset_type: "SA")` → discard

A Wallet duplicate, and Wallet wins. Only fetch it if some account carries
`balance_source: "indmoney"`, which none currently do.

### `networth_holdings(asset_type: "EPF")` → balances

One row per employer. `investment` → `ref`, `market_value` → `amount_inr`, kind `epf`.
Keep them separate; a job change then reads as one row ending and another starting.

EPF cannot be split into contribution versus interest — INDmoney holds a single number per
establishment. Never present an EPF change as market gain.

### `networth_snapshot` → US wallet cash

Idle dollars sitting in the INDmoney US brokerage wallet are liquid, and Wallet cannot see them,
same as Kite's idle cash in §1. `networth_holdings` has no asset type for it; the only place it
appears is `networth_snapshot`, in `investments[]` as `asset_type: "US_STOCK_WALLET"`.

`current_value` → a `cash` balance with `ref: "INDmoney US wallet"`, `amount_inr` that figure, and
`meta: {"source": "indmoney networth_snapshot US_STOCK_WALLET"}`. It is rupees only, with no USD
figure. Take nothing else from the snapshot. If `US_STOCK_WALLET` is absent the wallet is empty, so
send no row rather than a zero.

---

## 3b. Detect what was sold

Neither source will tell you. Kite's `get_trades`, `get_orders` and `get_positions` return **today
only** — all three came back `total: 0` when probed on a non-trading day — and INDmoney has no
transactions endpoint at all, only holdings, market data, SIPs and a watchlist. Past orders do not
exist over MCP.

So a sale is detected as the difference between two checkpoints. After posting, ask:

```bash
curl -s -H "Authorization: Bearer $FINGOD_API_TOKEN" localhost:8080/api/v1/disposals
```

Anything whose quantity fell is a sale. The response carries the quantity sold, the cost of exactly
those shares (average cost × quantity, the same basis a broker uses), and an estimate of the proceeds
**at the previous checkpoint's price**.

**That estimate is the one number to confirm, never assume.** The snapshot only ever sees what is
still held, so the actual sale price is the single thing it cannot know — a week of movement sits
between the last seen price and the truth. Ask the user what it went out at, offer the estimate as the
default, then record it:

```bash
curl -X POST localhost:8080/api/v1/trades -H "Authorization: Bearer $FINGOD_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"trades":[{
    "sleeve":"in_equity","symbol":"ACME","exit_date":"2026-09-12",
    "invested_inr":"40000.00","realised_inr":"8000.00","source":"refresh"}]}'
```

Trades already recorded are filtered out, so re-running a refresh never offers the same sale twice.

> **Two blind spots, and they are structural.** A stock bought *and* sold between two checkpoints is
> invisible — it never appears in a snapshot, so nothing can detect it. And a week where you both
> sold 300 and bought 100 of the same stock nets to a 200-share disposal, understating what was
> realised. Weekly checkpoints mean weekly resolution here as everywhere else. If a trade matters and
> happened inside the week, the user has to say so.

## 4. Manual — Bitcoin only

CoinDCX has no MCP. INDmoney reports a crypto *value* with `total_units: null`, so it cannot feed
the qty-diff engine, and it has read low when compared. Ask:

- **quantity** — default to `previous_manual.BTC.qty` from preflight
- **current total value in ₹**

Then `price = value / qty`, to 8 decimal places, `currency: "INR"`, `fx_rate: "1"`, sleeve `btc`.
Carry `avg_cost` and `invested_inr` over from `previous_manual.BTC` (the cost only changes if the
quantity does).

**Do not ask about fixed deposits or Splitwise.** Both are standing rows the API snapshots itself. If
the user volunteers a change, use `POST/PUT /api/v1/fixed-deposits` or
`PUT /api/v1/splitwise/{person}` — positive means they owe him — and then continue.

---

## 5. POST the checkpoint

```bash
curl -X POST localhost:8080/api/v1/checkpoints \
  -H "Authorization: Bearer $FINGOD_API_TOKEN" -H 'Content-Type: application/json' -d @payload.json
```

```jsonc
{ "as_of_date": "YYYY-MM-DD",
  "usd_inr": "<from INDmoney>",
  "sources": {"wallet":"ok","kite":"ok","indmoney":"ok","manual":"ok"},
  "holdings":  [ {"sleeve":"…","symbol":"…","isin":"…","name":"…",
                  "qty":"…","price":"…","currency":"INR","fx_rate":"1"} ],
  "balances":  [ {"kind":"cash|credit_card|epf","ref":"…","amount_inr":"…"} ],
  "wallet_accounts": [ {"id":"…","name":"…","account_type":"…"} ] }
```

Send **`qty` and `price`; never compute `value_inr` yourself.** The API computes it in Postgres
NUMERIC as `round(qty × price × fx_rate, 2)`. You may include the source's own total — it is
cross-checked and any disagreement over ₹1 comes back in `warnings`, which is a useful signal that a
mapping is wrong.

Responses: **201** new, **200** replaced, **409** an unclassified account (nothing was written —
fix per §2a and re-post), **400** a bad payload with the offending field named.

### If a source fails

Write the checkpoint anyway. Carry that sleeve's holdings forward verbatim from the last checkpoint
and set `sources.<name>: "stale"`. A stale sleeve is excluded from that period's attribution rather
than booked as a move to zero — the series must never read as a crash. Tell the user plainly which
source was stale and why.

---

## 6. Verify, then report

```bash
curl -s -H "Authorization: Bearer $FINGOD_API_TOKEN" localhost:8080/api/v1/checkpoints/<date>
```

Sanity checks worth doing every time:

- Sleeve totals in the right order of magnitude against last checkpoint. A sleeve that halved is
  either a real event or a mapping bug — find out which before reporting it as news.
- Any `warnings` in the POST response.
- No symbol in both `in_equity` and `us_equity`.
- Holding count roughly stable. A drop of ten is a paging bug, not ten sales.

Then tell the user: both net worth figures, what moved since last checkpoint **split into market /
flow / fx**, anything stale, and anything flagged. The split is the point — "up ₹40,000" is not an
answer, "₹12,000 of gain and ₹28,000 of money you added" is.

### Price watch — always include it in the report

Two things the owner wants to hear about on every refresh, whatever the checkpoint itself showed.
Read-only, via INDmoney. `entity_stats` carries `52week_high` and `52week_low` for both US and
Indian instruments, so there is no need to pull candles.

**Mega US stocks near their 52-week low or substantially down.**

1. Build the list. Take every held `us_equity` symbol, plus candidates from
   `get_us_stocks_movers`: `52-week-low` (limit 50) filtered to `mcap_usd ≥ 200e9`, and
   `mega-cap-losers` (limit 50) filtered to `historic_returns.6m` or `.1y` ≤ −15%. The losers
   list is *today's* losers only, so a mega cap that slumped earlier but rose today can slip
   through. Say so if it matters.
2. `get_us_stocks_details(symbols=[…])`, max 10 per call. Keep rows whose
   `entity_basic.market_cap == "Mega Cap"`. A held name that is only `Large Cap` is not mega:
   report it separately as held, not as a mega cap.
3. For each, `live_price` against `52week_low` / `52week_high`. **Flag** if within 10% above the low
   (`price / low − 1 ≤ 0.10`) **or** at least 20% below the high (`1 − price / high ≥ 0.20`).
4. Report symbol, price, % above the 52-week low, % below the 52-week high, and mark held ones.
   Say plainly if nothing qualifies.

Distrust a `52week_low` of `0` (LVMUY, an ADR, returned that). Use `historic_returns` from the
movers feed for such a name and say the range was unavailable.

**GOLDBEES.** `lookup_ind_keys` returns more than one row for "GOLDBEES"; take the one whose
`get_indian_stocks_details` has `entity_basic.symbol == "GOLDBEES"` (currently `INDS19240`).
Report `live_price`, % above the 52-week low and % below the 52-week high, with the same two
thresholds, and say so when it is neither near the low nor substantially down.

Prices are the last trade, which is the previous close at weekends. Say which when it matters.
