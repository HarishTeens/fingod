# MCP response shapes

What the three MCP servers return, and how fingod maps each response onto a checkpoint. Every value
below is **invented** — these are shapes, not anyone's data.

The refresh routine in `.claude/skills/refresh/SKILL.md` is the executable version of this document.

---

## Wallet (BudgetBakers)

Plain streamable HTTP, stateless. Authenticates with `Authorization: Bearer <token>`, generated in
the Wallet app under Settings → MCP. Granted scopes are read-only: nothing fingod does can change
Wallet.

### Envelope

Success and failure use different keys, so a client that reads only one will mishandle the other:

```jsonc
// success
{"result": {"structuredContent": { /* payload */, "_meta": { /* rate limit */ }}}}
// failure
{"result": {"isError": true, "content": [{"type": "text", "text": "schema validation failed at /limit: …"}]}}
```

### Limits

- `limit` is per tool. `get_accounts` allows **20**; `get_records` allows **400**; `get_categories`
  allows 200. Ask for the maximum.
- A 400-record page can overflow the tool-result budget, and Claude Code then spills it to a file
  under `tool-results/`. That is the preferred path: process the file with `jq` or Python so the
  records never enter the context window.
- The rate limit is reported on every response as `_meta.rateLimit` (`capacity`, `refillPerMinute`,
  `remaining`). Read `remaining` and back off rather than counting calls.
- Paginate with `offset`, `nextOffset` and `total`.

### `get_records`

Labels and categories arrive inline, so no per-transaction lookups are needed.

```jsonc
{
  "id": "00000000-0000-0000-0000-000000000001",   // stable → transactions.id, makes ingest idempotent
  "accountId": "…", "accountName": "Card A",
  "recordDate": "2026-09-05T10:30:00Z",
  "amount": {"value": -500, "currencyCode": "INR"},   // negative = expense
  "note": "Coffee",
  "category": {"id": "…", "name": "Food & drinks", "group": {"name": "Food"}},
  "labels": [{"name": "One-Time"}],
  "transfer": null,                                    // non-null = a leg of an own-account transfer
  "recordState": "cleared"
}
```

Map to `POST /api/v1/transactions`: `txn_date` is the date part of `recordDate`; `is_transfer` is
`transfer !== null`; `category_top` is `category.group.name`; keep the whole record in `raw`.

### `get_accounts`

```jsonc
{
  "id": "…", "name": "Salary account", "accountType": "SavingAccount",
  "isInvestmentAccount": false, "isBankSync": false,
  "balance": {"currentBalance": 12345.67}        // a nested object, not a number
}
```

Wallet has no field that identifies a fixed deposit: a deposit is typed `General`, with
`isInvestmentAccount: false`, exactly like a salary account. Type alone cannot decide what belongs in
the cash total, so the refresh routine asks you for an explicit **role** per account (`cash`,
`credit_card`, `ignore`) and remembers the answer in `data/config.json`. A role is never guessed.

Credit cards report debt as a **negative** balance. fingod stores outstanding as **positive**, so flip
the sign.

Accounts that are not bank-synced report a running total of manually entered records, which can drift
from the real bank balance. fingod carries that figure rather than overriding it.

---

## Zerodha Kite

Reached through the `mcp-remote` bridge, because direct HTTP is blocked by Cloudflare. Authenticates
with an interactive OAuth login; the login link is single-use and dies on `/mcp reconnect`.

> **Read-only.** The server also exposes `place_order`, `modify_order`, `cancel_order` and GTT tools.
> fingod never calls them.

`get_trades`, `get_orders` and `get_positions` return **today only**, so past orders do not exist over
MCP. A sale is detected by diffing two checkpoints instead.

### `get_holdings` — Indian equity, ETFs, gold, liquid funds

```jsonc
{
  "tradingsymbol": "ACME", "exchange": "NSE", "isin": "INE000A01001",
  "quantity": 100, "t1_quantity": 0,           // t1 is bought and paid for: add it
  "average_price": 120.5, "last_price": 135.2,
  "day_change": 1.2, "pnl": 0
}
```

| Field | Maps to |
|---|---|
| `tradingsymbol` | `symbol` |
| `isin` | `isin` — required; tickers get renamed |
| `quantity + t1_quantity` | `qty` |
| `last_price` | `price` |
| `average_price` | `avg_cost`; `invested_inr = round(qty × average_price, 2)` |

Gold and liquid ETFs arrive as ordinary equity. They are not equity, so they are classified by ISIN
into the `gold` and `debt` sleeves. Overnight-rate ETFs are cash parked in the demat account.

### `get_mf_holdings` — units and NAV

```jsonc
{"folio": "…", "fund": "Example Midcap Fund - Direct Plan", "tradingsymbol": "INF000F01001",
 "quantity": 1000.5, "average_price": 48.1, "last_price": 52.3, "pnl": 0, "last_price_date": ""}
```

`tradingsymbol` **is** the ISIN. `fund` → `name`, `quantity` → `qty`, `last_price` → `price` (the NAV).
`pnl` and `last_price_date` are dead fields.

### `get_margins` — idle broker cash

`equity.available.cash` becomes a `cash` balance. It is usually small, but Wallet cannot see it.

---

## Groww

**Unverified.** This section is written from Groww's public product page, not from a real account. Where it says
"unknown", the server has not been inspected and the refresh routine must look at what it actually returns.

- **Server:** `https://mcp.groww.in/mcp`, Groww's official hosted MCP, reached through the bridge Groww documents,
  `npx -y mcp-remote https://mcp.groww.in/mcp 52155`. Sign-in is a browser link (OAuth), and it only accepts the
  bridge's callback `http://localhost:52155/oauth/callback`: a client's native OAuth (Claude Code sends a random port
  and `/callback`) is rejected.
- **Covers:** stocks and F&O (holdings, positions, P&L, market context). **Mutual funds, IPOs and bonds are not
  supported yet** ("will be added"), so Groww mutual funds are not read.
- **Can place orders** (buy, limit and stop-loss; sells need DDPI authorisation). The tool names are **unknown**, so
  fingod cannot pre-block them the way it blocks Kite's six. The refresh routine must list the tools, use only the
  clearly read-only ones, and tell the user which order tools to deny in their agent's config.
- **Holdings fields:** unknown. Expect a trading symbol or name, a quantity, an average price and a last price;
  an ISIN may or may not be present. Map defensively (SKILL.md §1b) and never assume a field exists.
- **Availability:** Groww describes access as limited and the product as early-stage.
- **Ownership:** a second broker for Indian stocks. The same ISIN at Zerodha and Groww is merged into one holding with
  quantities added (`docs/DATA-FORMAT.md`, "One stock at two brokers").

---

## INDmoney

Authenticates with OAuth 2.1 and PKCE. Every tool returns `{"result": "<json string>"}`, so parse the
payload a second time.

### What fingod takes

Only three things; everything else overlaps another source and is discarded:

1. **US equity** — `networth_holdings(asset_type="US_STOCK")`
2. **EPF** — `networth_holdings(asset_type="EPF")`
3. **US wallet cash** — `US_STOCK_WALLET` in `networth_snapshot`

### `networth_holdings(US_STOCK)`

```jsonc
{
  "holdings": [{
    "investment_code": "ACME", "investment": "Acme Corp",
    "total_units": 2.0129, "unit_price": 45000.0,        // unit_price is in RUPEES even for US stocks
    "current_value_usd": 1006.45, "market_value": 90580.5,
    "invested_amount": 80000.0                             // do not use: see below
  }],
  "asset_summary": {"total_value": 90580.5, "total_value_usd": 1006.45}
}
```

US holdings carry quantity **and** a native USD value, so the exchange rate is exactly recoverable:

```
usd_inr = asset_summary.total_value / asset_summary.total_value_usd
price   = current_value_usd / total_units
```

Deriving both from the source's own figures keeps `value_inr == qty × price × fx` exact. An external
FX quote would break that constraint.

`invested_amount` back-converts the USD cost at a **flat rate** regardless of purchase date, which
misstates cost and inflates the gain, so fingod ignores it. US rows carry no cost basis unless the
user supplies a true rupee figure.

### `networth_holdings(EPF)`

One row per employer, with `investment` (the employer) and `market_value`. There is no split between
contribution and interest, so an EPF change is never presented as market gain.

### `networth_snapshot`

Used only for idle USD in the US brokerage wallet: `investments[]` with
`asset_type: "US_STOCK_WALLET"` and `current_value` (rupees only). If the entry is absent the wallet
is empty, so send no row.

### Why INDmoney does not own everything

- **Mutual funds:** its feed reads from the registrar and lags SIP instalments, so Kite is fresher
  and shows more units for the same schemes.
- **Indian equity:** some holdings can be missing entirely.
- **Crypto:** reported as a value with `total_units: null`, so it cannot feed the qty-diff engine.
- **Bank accounts and liabilities:** these duplicate Wallet.

---

## Market data used by the price watch

Read-only calls via INDmoney:

- `get_us_stocks_movers` (`52-week-low`, `mega-cap-losers`) to find candidates.
- `get_us_stocks_details` (max 10 symbols per call). `entity_basic.market_cap` is `"Mega Cap"` for
  the largest companies, and `entity_stats` carries `live_price`, `52week_high` and `52week_low`.
- A `52week_low` of `0` means the range is unavailable (seen on some ADRs). Do not trust it.
- `lookup_ind_keys` can return several rows for one name; pick the one whose
  `get_indian_stocks_details` has the matching `entity_basic.symbol`.
