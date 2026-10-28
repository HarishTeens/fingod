# Data format

fingod's browser app imports two kinds of JSON file from the `data/` folder. Your coding agent writes
them; you never have to. Both are **idempotent**: importing a file twice changes nothing, and a
re-written file replaces what it replaced before.

```
data/checkpoints/<YYYY-MM-DD>.json     a snapshot of everything you own on one date
data/transactions/<anything>.json      Wallet expense records
```

Any local static server works. `python3 -m http.server 8000 --bind 127.0.0.1` lists each folder as HTML and the app
reads those listings; `python3 serve.py` adds a `/data/manifest.json`. The app polls every few seconds and
imports any file that is new or changed. A file it can't import is reported by name and field. You can also drop files onto the setup page, or use **Data → Choose files**.

## Checkpoint

A checkpoint is an immutable snapshot. Send **quantity and price, never a total**: the app computes
`value_inr = round(qty × price × fx_rate, 2)` itself.

```jsonc
{
  "as_of_date": "2026-10-29",          // required, YYYY-MM-DD; one file per date
  "usd_inr": 90.12,                    // required if any holding is in USD without its own fx_rate
  "sources": {                         // which sources were read: "ok" | "stale"
    "wallet": "ok", "kite": "ok", "indmoney": "ok", "manual": "ok"
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
      "invested_inr": 35200.0          // optional; without it the holding has no return figure
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

### Merging

Several connectors contribute to the same date. If `data/checkpoints/<today>.json` already exists, **read
it and merge your sleeves in** rather than overwriting it: replacing a sleeve you own is correct;
dropping one you don't is a bug.

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

## Config

`data/config.json` is optional and **only your agent reads it**: a place to remember which Wallet
accounts you said are cash, credit cards, or to ignore, so it doesn't ask again.

```jsonc
{ "wallet_account_roles": { "<account id>": { "name": "Bank A", "role": "cash" } } }  // cash | credit_card | ignore
```

## Standing rows (optional)

`data/standing/<anything>.json` carries the rows that normally live in the app: fixed deposits, Splitwise
balances, confirmed trades and the target allocation. It is the way to **bring existing history in**.
Import is idempotent: a deposit is matched on bank + principal + start date, a trade on
`(sleeve, symbol, exit_date, invested_inr)`, a person by name.

```jsonc
{
  "fixed_deposits": [ { "bank": "Example Bank", "principal": 100000, "rate_pct": 6.5, "start_date": "2026-02-01", "maturity_date": "2027-02-01", "compounding": "quarterly" } ],
  "splitwise":      [ { "person": "Friend A", "amount_inr": 3000, "note": "" } ],                 // positive = they owe you
  "trades":         [ { "sleeve": "in_equity", "symbol": "ACME", "exit_date": "2026-06-03", "invested_inr": 18000, "realised_inr": -2200, "holding_days": 60 } ],
  "target_allocation": { "in_equity": 27, "in_mf": 35, "us_equity": 10, "gold": 5, "btc": 5, "fd": 15, "debt": 2, "liquid": 1 }
}
```

A checkpoint file may also carry its own `splitwise` balances. They are then stored as given instead of
being snapshotted from the standing rows, which is how a history export keeps what was true on each date.
