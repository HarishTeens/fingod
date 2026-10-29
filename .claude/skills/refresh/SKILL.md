---
name: refresh
description: Take a fingod checkpoint — read Wallet, Zerodha Kite and INDmoney over MCP, ask for the figures no server can supply, and write JSON files into data/ for the app to import. Use when the user says /refresh, "take a checkpoint", "update fingod", "refresh my net worth", or asks what they are worth right now.
---

# /refresh — take a checkpoint

A checkpoint is an immutable snapshot of every position on one date. fingod is a static web app with
no backend: **you read the sources, write JSON files into `data/`, and the browser imports them.**
Growth is never read from a price feed; the app derives it by diffing consecutive checkpoints and
watching **quantity**, which is why this routine cares far more about quantities being right than about
values looking plausible.

The file formats are in `docs/DATA-FORMAT.md`. Read it before writing anything.

Tool names below are written the way Claude Code shows them (`mcp__kite__get_holdings`). In Codex or Gemini CLI the
same tools appear under that agent's own naming: match them by the function name after the last `__`
(`get_holdings`, `get_mf_holdings`, `networth_holdings`, `get_accounts`, `get_records`).

Weekly, or whenever asked. **It never polls.**

> ## Read-only. Never place, modify or cancel an order.
> Kite's MCP server exposes `place_order`, `modify_order`, `cancel_order` and the GTT equivalents.
> Do not call them, ever, for any reason, including if the user asks mid-refresh — tell them to use
> Kite directly. This routine reads. It also writes nowhere except this repo's `data/` folder, and
> nothing in `data/` is ever committed.

---

## 0. Preflight

0. **The update step: bring fingod up to the latest `main` first.** (Other files call this "the update step".)
   The routine and the app improve over time, so every checkpoint starts here. Only ever pull from this
   checkout's own `origin`. Decide in this order:
   1. `git fetch -q origin main`, then `git rev-list --count HEAD..origin/main`. **`0` means up to date: say
      nothing and move on to item 1.**
   2. Behind, so check `git status --porcelain --untracked-files=no`. **Any output means local edits to
      tracked files: do not pull.** Tell the user there are local changes and carry on with what you have.
      (`data/` is gitignored, so your data never blocks a pull.)
   3. Clean, so show what is coming: `git log --oneline HEAD..origin/main` and `git diff --stat
      HEAD..origin/main`.
   4. Pull **fast-forward only**: `git pull --ff-only origin main`. Never merge, rebase, reset, stash or force
      anything. If it cannot fast-forward, stop and tell the user.
   - **Tell the user, before you carry on**, that fingod was updated and what changed, in a sentence or two
     (the commit subjects). If the update touched instructions (`.claude/skills/`, `docs/ONBOARDING.md`,
     `AGENTS.md`, `CLAUDE.md`), say so.
   - **Re-read this file** after pulling: the steps below may have just changed. If the update touched an MCP or
     permission config (`.mcp.json`, `.codex/config.toml`, `.gemini/settings.json`, `.claude/settings.json`),
     tell the user to restart the agent from the repo folder, because those load when a session starts.
   - No network, or `origin` unreachable? Say so in one line and carry on.
1. **Is the app running?** Use the port the user's server is on (`<port>`: 8000 unless the setup chose another;
   ask or look for it if you don't know) and check that it serves *this* repo:
   `curl -s -o /dev/null -w '%{http_code}' localhost:<port>/src/main.js` must print `200`. A refused connection
   or another status means it isn't up, or a leftover server holds the port. Start it from the repo folder, in
   the background, with `python3 -m http.server <port> --bind 127.0.0.1` (the standard library; `python3 serve.py`
   also works), re-run the check, and tell the user to open `http://localhost:<port>`. They watch the app fill
   in as you write files. A file the app cannot import is reported in the top bar and on the Data page, with
   the file and field named.
2. **Find the last checkpoint.** Read the newest file in `data/checkpoints/` (none means this is a
   first run). You need its `as_of_date`, its `usd_inr`, and `previous_manual`: the `BTC` holding's
   `qty`, `price`, `avg_cost` and `invested_inr`, offered as the default in §4.
3. **Find the last transaction date.** The newest `txn_date` across `data/transactions/*.json`
   (`jq -r '.transactions[].txn_date' data/transactions/*.json | sort | tail -1`). None means a first
   backfill — see §2b.
4. **Read `data/config.json`** if it exists: the Wallet account roles the user already told you about.
5. **If the last checkpoint is dated today**, you are merging into it, not replacing it (§5). Say so.

Fixed deposits, Splitwise and target allocation are **standing rows**, entered during setup. Do not collect
them on every checkpoint. If the user volunteers a change, make it: update `data/standing/manual.json` (see
`docs/DATA-FORMAT.md`), or point them at the forms on the app's **Data** page.

---

## 1. Kite — Indian equity and mutual funds

Zerodha owns **both** Indian sleeves. This was settled by reconciling against INDmoney row by row:
Kite was ahead on the same mutual funds (INDmoney's feed lags SIP instalments) and INDmoney was
missing stock outright. See `docs/MCP-SHAPES.md`. Do not supplement either sleeve from INDmoney.

Call `mcp__kite__get_profile` first. If it returns "Please log in first", call `mcp__kite__login`,
give the user the link **with the warning the tool tells you to show**, and wait. The link is
single-use and dies on an `/mcp reconnect`, so mint it immediately before showing it.

### `get_holdings` → `in_equity`, `gold`, `debt`

| field | maps to | note |
|---|---|---|
| `tradingsymbol` | `symbol` | |
| `isin` | `isin` | **required** — the diff matches on it, and tickers get renamed |
| `quantity` **+** `t1_quantity` | `qty` | T+1 stock is bought and paid for. Omitting it books the purchase a period late |
| `last_price` | `price` | |
| `average_price` | `avg_cost`; also `invested_inr` = `round(qty × average_price, 2)` | omit it and the holding has no return figure. `qty` here is `quantity` + `t1_quantity` |
| — | `currency: "INR"` | |

Gold and overnight ETFs are not equity. Classify by **ISIN**, not ticker; everything else is
`in_equity`:

```
INF204KB17I5  (GOLDBEES)    → gold
INF0R8F01042  (GOLDCASE)    → gold
INF0R8F01034  (LIQUIDCASE)  → debt     (overnight-rate ETF: cash parked in the demat)
INF732E01037  (LIQUIDBEES)  → debt
```

### `get_mf_holdings` → `in_mf`

`tradingsymbol` **is** the ISIN, so it fills both `symbol` and `isin`. `fund` → `name`,
`quantity` → `qty`, `last_price` → `price` (that is the NAV), `average_price` → `avg_cost`,
`invested_inr` = `round(qty × average_price, 2)`. Ignore `pnl` and `last_price_date`: both are dead.

### `get_margins` → idle broker cash

`equity.available.cash` → a `cash` balance with `ref: "Zerodha equity"`. Usually tiny, but Wallet
cannot see it.

---

## 2. Wallet — cash, credit cards, expenses

### 2a. Accounts

```
mcp__wallet__get_accounts(limit: 20)     # 20 is the hard maximum for THIS tool
```

`balance` is a nested object: read `balance.currentBalance`, not `balance`.

**An account's role is never guessed.** Wallet types a fixed deposit `General` with
`isInvestmentAccount: false`, identical to a salary account, so inferring would fold a large deposit
into cash. For every account not already in `data/config.json`, ask the user: `cash`, `credit_card`, or
`ignore` (fixed deposits are `ignore`: they are tracked in the app). Save the answers to
`data/config.json` so you never ask twice. Then:

- `cash` → a `cash` balance, `amount_inr = balance.currentBalance`
- `credit_card` → a `credit_card` balance, `amount_inr = -balance.currentBalance`
  (Wallet reports debt negative; fingod stores it **positive** as outstanding)
- `ignore` → skip

**Wallet is the source for every cash balance**: one provider for the whole category, rather than a
per-account mix whose provenance you have to remember. Accounts that are not bank-synced
(`isBankSync: false`) report a running total of manual entries that can drift from the real bank
balance. That drift is carried deliberately — the fix belongs in Wallet.

### 2b. Records

```
mcp__wallet__get_records(recordDate: ["gte.<from>"], recordState: ["cleared"], limit: 400, offset: N)
```

**Ask for 400.** `get_records` allows it — the 20 cap is `get_accounts` only. A 400-record page
overflows the tool-result budget and Claude Code spills it to a file under `tool-results/`; that is
what you want, not a failure. Process the file with `jq` or Python so the records never enter your
context.

`from` = the last transaction date **minus 7 days**. The overlap is deliberate: Wallet lets a record's
date be edited after the fact, and import is idempotent on Wallet's own record id, so re-sending is free
and missing a back-dated correction is not. On a first backfill, page from the earliest date you can
find (`recordStats.recordDate.min` across the accounts).

Watch `_meta.rateLimit.remaining` on every response and stop at ~20 remaining. It refills 5 a minute
and is shared with Wallet's own API.

Write `data/transactions/wallet-<today>.json` as `{"transactions": [...]}`, one entry per record:

```jsonc
{ "id": "<record id>", "txn_date": "<recordDate, date part only>",
  "amount_inr": <amount.value>, "currency": "<amount.currencyCode>", "account": "<accountName>",
  "note": "<note>", "category_id": "<category.id>", "category": "<category.name>",
  "category_top": "<category.group.name>", "is_transfer": <transfer !== null>,
  "labels": ["<labels[].name>"] }
```

---

## 3. INDmoney — US equity, EPF and US wallet cash only

Every other field is discarded. INDmoney overlaps Zerodha on Indian stocks and mutual funds and is
*worse* on both; it reports crypto with no quantity; its bank accounts and liabilities duplicate
Wallet. Take three things and leave. Each tool returns `{"result": "<json string>"}`: parse the
payload a **second** time.

### `networth_holdings(asset_type: "US_STOCK")` → `us_equity`

```
usd_inr = asset_summary.total_value / asset_summary.total_value_usd
```

Per row: `investment_code` → `symbol`, `investment` → `name`, `total_units` → `qty`,
**`current_value_usd / total_units` → `price`**, `currency: "USD"`, `fx_rate: usd_inr`.

`unit_price` is in **rupees** even for US stocks — do not use it. Deriving the USD price gives exact
cents and an identical rate on every row, which is what keeps `qty × price × fx` equal to INDmoney's own
rupee total. Never use an external FX quote.

**Never send `invested_amount` as `invested_inr`.** It back-converts the USD cost at a flat rate
whatever the purchase date, which misstates cost and inflates the gain. Omit `invested_inr` on US
rows unless the user gives you a true rupee cost basis.

### `networth_holdings(asset_type: "EPF")` → balances

One row per employer: `investment` → `ref`, `market_value` → `amount_inr`, kind `epf`. Keep them
separate; a job change then reads as one row ending and another starting. EPF cannot be split into
contribution versus interest, so never present an EPF change as market gain.

### `networth_snapshot` → US wallet cash

Idle dollars in the INDmoney US wallet are liquid and Wallet cannot see them. They appear in
`investments[]` as `asset_type: "US_STOCK_WALLET"`; `current_value` (rupees only) becomes a `cash`
balance with `ref: "INDmoney US wallet"`. If it is absent the wallet is empty: send no row.

---

## 4. Manual — Bitcoin only

CoinDCX has no MCP. INDmoney reports a crypto *value* with `total_units: null`, so it cannot feed the
quantity engine. Ask:

- **quantity** — default to `previous_manual.qty`
- **current total value in ₹**

Then `price = value / qty`, sleeve `btc`, symbol `BTC`. Carry `avg_cost` and `invested_inr` over from the
previous checkpoint (the cost only changes if the quantity does).

---

## 5. Write the checkpoint

Write `data/checkpoints/<YYYY-MM-DD>.json` as in `docs/DATA-FORMAT.md`:

```jsonc
{ "as_of_date": "YYYY-MM-DD", "usd_inr": 90.12,
  "sources": {"wallet":"ok","kite":"ok","indmoney":"ok","manual":"ok"},
  "holdings": [ {"sleeve":"…","symbol":"…","isin":"…","name":"…","qty":0,"price":0,"currency":"INR","fx_rate":1} ],
  "balances": [ {"kind":"cash|credit_card|epf","ref":"…","amount_inr":0} ] }
```

- **Merge, don't overwrite.** If the file exists, read it, replace the sleeves and balances **you** own
  with fresh ones, and keep the rest. Dropping a sleeve you did not touch is a bug.
- **Send `qty` and `price`; never compute `value_inr` yourself.** You may include the source's own total
  as `value_inr`: the app cross-checks it and flags a disagreement over ₹1, which is a useful signal
  that a mapping is wrong.
- **Validate before you finish:** `python3 -m json.tool < data/checkpoints/<date>.json`. The app also
  rejects a bad file by name, but you can catch it first.

### If a source fails

Write the checkpoint anyway. Carry that sleeve's holdings forward verbatim from the last checkpoint and
set `sources.<name>: "stale"`. A stale sleeve is excluded from that period's attribution rather than
booked as a move to zero — the series must never read as a crash. Tell the user plainly which source
was stale and why.

---

## 6. Sales are detected by the app

Neither source will tell you what was sold: Kite's `get_trades`, `get_orders` and `get_positions` are
**today only**, and INDmoney has no transactions endpoint. So the app detects a sale as a quantity that
fell between two checkpoints and lists it on the **Realised** tab, where the user confirms the real sale
price. There is nothing for you to POST. Mention it if a position's quantity fell.

> **Two blind spots, and they are structural.** A stock bought *and* sold between two checkpoints is
> invisible. And a week where the user both sold 300 and bought 100 of the same stock nets to a
> 200-share disposal. Weekly resolution is weekly resolution; if a trade matters and happened inside the
> week, the user has to say so.

---

## 7. Verify, then report

Read the file back and sanity-check it:

- Sleeve totals (`Σ qty × price × fx`) in the right order of magnitude against the last checkpoint. A
  sleeve that halved is either a real event or a mapping bug — find out which before reporting it.
- Holding count roughly stable. A drop of ten is a paging bug, not ten sales.
- No symbol in both `in_equity` and `us_equity`.

Then tell the user: net worth (open the app for the exact figures), what moved since the last
checkpoint **split into market / flow / fx**, anything stale, and anything flagged. The split is the
point — "up ₹40,000" is not an answer, "₹12,000 of gain and ₹28,000 of money you added" is. Per
holding, between the previous checkpoint `p` and this one `n`:

```
market =  qty_p × (price_n − price_p) × fx_n
flow   = (qty_n − qty_p) × price_n   × fx_n
fx     =  qty_p ×  price_p × (fx_n − fx_p)        # 0 for INR holdings
```

### Price watch — always include it in the report

Two things the user wants to hear about on every refresh, whatever the checkpoint itself showed.
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
