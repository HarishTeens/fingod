# Data format

fingod's browser app imports a few kinds of JSON file from the `data/` folder. Your coding agent writes
them; you never have to. All are **idempotent**: importing a file twice changes nothing, and a
re-written file replaces what it replaced before.

```
data/checkpoints/<YYYY-MM-DD>.json     a snapshot of everything you own on one date
data/transactions/<anything>.json      Wallet expense records
data/ledger/<anything>.json            every buy and sell, from a tradebook or a CAS (optional)
data/benchmarks/<anything>.json        daily Nifty 50 and S&P 500 history, loaded in one go (optional)
data/standing/<anything>.json          rows that normally live in the app (optional)
```

Any local static server works. `python3 -m http.server 8000 --bind 127.0.0.1` lists each folder as HTML and the app
reads those listings; `python3 serve.py` adds a `/data/manifest.json`. The app polls every few seconds and
imports any file that is new or changed. A file it can't import is reported by name and field. You can also drop files onto the empty-state page, or use **Data → Choose files**.

## Checkpoint

A checkpoint is an immutable snapshot. Send **quantity and price, never a total**: the app computes
`value_inr = round(qty × price × fx_rate, 2)` itself.

```jsonc
{
  "as_of_date": "2026-10-29",          // required, YYYY-MM-DD; one file per date
  "usd_inr": 90.12,                    // required if any holding is in USD without its own fx_rate
  "sources": {                         // which sources were read: "ok" | "stale"
    "wallet": "ok", "kite": "ok", "groww": "ok", "indmoney": "ok", "manual": "ok"
  },
  "holdings": [
    {
      "sleeve": "in_equity",           // in_equity | in_mf | us_equity | gold | debt | btc
      "symbol": "ACME",                // required; unique within a sleeve
      "isin": "INE000A01001",          // strongly recommended: holdings are matched across dates on ISIN
      "name": "Acme Industries",
      "qty": 100,                      // required. For Kite equity: quantity + t1_quantity
      "price": 410.5,                  // required. Per unit, in the holding's own currency
      "currency": "INR",               // "INR" (default) or "USD"
      "fx_rate": 1,                    // currency → INR; defaults to 1 for INR, usd_inr for USD
      "avg_cost": 352.0,               // optional
      "invested_inr": 35200.0,         // optional; without it the holding has no return figure
      "brokers": { "kite": { "qty": 60, "invested_inr": 21000 }, "groww": { "qty": 40, "invested_inr": 14200 } }  // optional, see below
    }
  ],
  "balances": [
    { "kind": "cash",        "ref": "Bank A",       "amount_inr": 12345.67 },
    { "kind": "credit_card", "ref": "Card A",       "amount_inr": 5000 },   // POSITIVE = outstanding
    { "kind": "epf",         "ref": "Employer One", "amount_inr": 100000 }
  ],
  "wallet_accounts": [                 // optional: accounts seen, for reference
    { "id": "…", "name": "Bank A", "account_type": "SavingAccount" }
  ]
}
```

Rules the app enforces (and reports by name when broken):

- `sleeve` must be one of the six above, and `(sleeve, symbol)` must be unique in a file.
- `qty` and `price` must be numbers. A `USD` holding needs an `fx_rate` or a checkpoint `usd_inr`.
- `credit_card` amounts are stored **positive** as outstanding. Wallet reports them negative, so flip
  the sign before writing.
- `splitwise` balances are **never** sent in a checkpoint. They are standing rows entered in the app and
  snapshotted into each checkpoint, so history keeps what was true at the time.
- Fixed deposits are standing rows too, entered in the app and valued by formula.
- If a source failed, carry that sleeve forward **verbatim** from the previous checkpoint and set
  `sources.<name>: "stale"`. A stale sleeve is excluded from that period's attribution instead of being
  booked as a move to zero.
- If a hand-entered Bitcoin position exists in the app and the file has no `btc` holding, the app carries
  it forward into the checkpoint.

### One stock at two brokers

A user can hold Indian stocks at both Zerodha (Kite) and Groww. Holdings are matched on ISIN, so the **same ISIN
must appear once**: write **one** holding with the quantities and `invested_inr` **added** and
`avg_cost = invested_inr / qty`. The optional `brokers` map records each broker's share. The app ignores it; the
refresh routine reads it so that if one broker fails, only that broker's share is carried forward (`sources.<broker>:
"stale"`) while the other's is refreshed.

### Merging

Several connectors contribute to the same date. If `data/checkpoints/<today>.json` already exists, **read
it and merge your sleeves in** rather than overwriting it: replacing a sleeve you own is correct;
dropping one you don't is a bug.

### Benchmarks (optional)

The Investments page can set your portfolio against the Nifty 50 and the S&P 500. There are two ways to
supply them, and both are optional.

**History in one file (preferred).** `data/benchmarks/<anything>.json` carries daily closes for as many days as
you like, so a backfill is one file instead of an edit per checkpoint:

```jsonc
{ "benchmarks": {
    "nifty50": [ { "date": "2026-10-28", "level": 22698.85 }, { "date": "2026-10-29", "level": 22936.75 } ],  // the index close
    "sp500":   [ { "date": "2026-10-28", "level": 772.31 },   { "date": "2026-10-29", "level": 769.36 } ]     // SPY's close in USD
} }
```

A checkpoint reads the close on its own date, or the nearest earlier one within **7 days** (a Sunday checkpoint
reads Friday's close). Further back than that it shows nothing rather than guess. Re-sending is idempotent on
`(benchmark, date)`, so a later, longer file just adds the new days.

**One level per checkpoint.** A checkpoint may also carry its own, which wins over the history:

```jsonc
"benchmarks": { "nifty50": 24500.35, "sp500": 560.12 }   // nifty50: the index level; sp500: SPY's price in USD
```

`sp500` is SPY's price rather than an index level, and is converted to rupees with that checkpoint's `usd_inr`,
which is what an Indian investor earned. A comparison appears once two checkpoints can see the same
benchmark, and every line starts at 100 on the latest date they all have in common.

## Transactions

```jsonc
{
  "transactions": [
    {
      "id": "00000000-0000-0000-0000-000000000001",  // required: Wallet's own record id (idempotency key)
      "txn_date": "2026-10-03",                      // required, date part only
      "amount_inr": -1200.5,                         // required; negative = expense
      "currency": "INR",
      "account": "Bank A",
      "note": "Dinner",
      "category_id": "…", "category": "Restaurant, fast-food", "category_top": "Food & Drinks",
      "is_transfer": false,                          // true for a leg of an own-account transfer
      "labels": ["Food"]
    }
  ]
}
```

Wallet's category and label names arrive inline on every record, so no per-record lookups are needed.
Re-sending records is free, which is why a refresh should start a week **before** the last transaction
it already has: Wallet lets a record's date be edited after the fact.

### How expenses are drawn

Spend charts are net of money that came back, and exclude transfers and Investments. The exact rules
are in [ARCHITECTURE.md](ARCHITECTURE.md#expenses).

## Trade ledger (optional)

`data/ledger/<anything>.json` is every buy and sell your agent could read from a tradebook or a mutual
fund statement. Checkpoints alone cannot date a purchase or price a sale; with a ledger the app can compute
**exact XIRR**, the **cost and holding period of every lot**, and **capital gains** by financial year.
Nothing needs it to run.

```jsonc
{
  "ledger": [
    {
      "id": "1234567",               // optional: the broker's trade id. Without one, the row's own content is the key
      "sleeve": "in_equity",         // same sleeves as a checkpoint
      "symbol": "ACME", "isin": "INE000A01001", "name": "Acme Industries",
      "trade_date": "2025-02-10",    // required, YYYY-MM-DD
      "side": "buy",                 // buy | sell
      "qty": 100, "price": 410.5,    // price per unit, in the instrument's own currency
      "currency": "INR", "fx_rate": 1,   // a foreign trade needs the rate on the day, so cost is in rupees
      "fees_inr": 25,                // optional: brokerage, STT, stamp duty. Added to a buy's cost, taken off a sale's proceeds
      "source": "kite tradebook"
    }
  ]
}
```

- **Match on ISIN**, as everywhere. A trade with no ISIN matches on sleeve and symbol.
- A switch between funds is a `sell` of one and a `buy` of the other. A SIP instalment is a `buy`.
- Lots are matched **first-in first-out**. A sale with no purchase behind it (the ledger starts after the
  position was opened) is reported, never counted as pure profit.
- The Realised page compares the ledger with the latest checkpoint's quantities and names every position
  that disagrees. A bonus or a split changes quantity without a trade, and is not modelled: add the rows
  yourself or accept the flag.
- A sleeve's XIRR comes from the ledger only when it covers every holding in that sleeve and the
  quantities agree; otherwise it falls back to the checkpoints.

## Config

`data/config.json` is optional and personal to you, like everything in `data/`. Your agent reads most of it: which
Wallet accounts you said are cash, credit cards, or to ignore, so it doesn't ask again, and positions you hold on
someone else's behalf, so they never count as yours. The **app** reads one key, `runway`.

```jsonc
{
  "wallet_account_roles": { "<account id>": { "name": "Bank A", "role": "cash" } },  // cash | credit_card | ignore
  "exclude_holdings": [ { "sleeve": "us_equity", "symbol": "ACME", "qty": 0.5, "note": "bought for a friend" } ],
  "runway": { "labels": ["Personal", "House"], "months": 3 }                          // months is optional: 1 to 12, default 3
}
```

For each `exclude_holdings` entry the agent subtracts `qty` from the source's quantity before writing a
checkpoint; leave `qty` out to ignore the whole position. A checkpoint therefore never contains the excluded
shares, and neither does net worth.

`runway` narrows what runway divides by. Without it, runway is net worth ÷ your average monthly spend on
everything. With it, only the Wallet labels you list count, which suits someone who expects to cut trips and one-offs
and treats the rest as their ongoing cost of living. The average is over the last `months` complete months and uses
the same label netting as the spend chart (a record with several labels shares its amount evenly between them, and
refunds come off the label they came back under), so a bar and the figure agree. The savings rate and "Spend a
month" still use all spending. Remove the key and runway goes back to all spending.

## Standing rows (optional)

`data/standing/<anything>.json` carries the rows that normally live in the app: fixed deposits, Splitwise
balances, confirmed trades and the target allocation. It is the way to **bring existing history in**.
Import is idempotent: a deposit is matched on bank + principal + start date, a PPF deposit on date + amount, a PPF rate on its quarter, a trade on
`(sleeve, symbol, exit_date, invested_inr)`, a person by name.

```jsonc
{
  "fixed_deposits": [ { "bank": "Example Bank", "principal": 100000, "rate_pct": 6.5, "start_date": "2026-02-01", "maturity_date": "2027-02-01", "compounding": "quarterly" } ],
  "ppf":            { "deposits": [ { "date": "2026-04-02", "amount_inr": 150000 } ], "rates": [ { "quarter_start": "2026-10-01", "rate_pct": 7.1 } ] },   // rates are set per quarter (Jan, Apr, Jul, Oct 1st)
  "splitwise":      [ { "person": "Friend A", "amount_inr": 3000, "note": "" } ],                 // positive = they owe you
  "assets":         [ { "kind": "nps", "name": "NPS Tier 1", "value_inr": 180000, "as_of_date": "2026-10-30" } ],   // nps | property | gold_physical | vehicle | other
  "liabilities":    [ { "kind": "car_loan", "name": "Car loan", "value_inr": 128000, "as_of_date": "2026-10-30" } ],   // home_loan | car_loan | personal_loan | education_loan | other; the amount you owe, positive
  "trades":         [ { "sleeve": "in_equity", "symbol": "ACME", "exit_date": "2026-06-03", "invested_inr": 18000, "realised_inr": -2200, "holding_days": 60 } ],
  "target_allocation": { "in_equity": 27, "in_mf": 35, "us_equity": 10, "gold": 5, "btc": 5, "fd": 15, "debt": 2, "liquid": 1 }
}
```

**Assets and liabilities** are things with no MCP behind them. Each entry is dated: a new value for the
same `kind` and `name` adds a newer entry, and a checkpoint reads the latest entry on or before its date, so
history keeps what was true then. They move **total** net worth only; liquid is untouched.

A checkpoint file may also carry its own `splitwise` balances. They are then stored as given instead of
being snapshotted from the standing rows, which is how a history export keeps what was true on each date.
