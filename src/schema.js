// The whole schema. SQLite, in the browser, persisted to IndexedDB.
// Bump SCHEMA_VERSION and add a step to MIGRATIONS to change it later.
export const SCHEMA_VERSION = 1

export const MIGRATIONS = [
  // 1
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE checkpoints (
    id          INTEGER PRIMARY KEY,
    as_of_date  TEXT NOT NULL UNIQUE,            -- YYYY-MM-DD
    usd_inr     REAL,
    sources     TEXT NOT NULL DEFAULT '{}',      -- {"wallet":"ok","kite":"stale",...}
    created_at  TEXT NOT NULL
  );

  CREATE TABLE holdings (
    id            INTEGER PRIMARY KEY,
    checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
    sleeve        TEXT NOT NULL,                  -- in_equity | in_mf | us_equity | gold | debt | btc
    symbol        TEXT NOT NULL,
    name          TEXT,
    isin          TEXT,
    qty           REAL NOT NULL,
    price         REAL NOT NULL,                  -- per unit, in the holding's own currency
    fx_rate       REAL NOT NULL DEFAULT 1,        -- that currency -> INR
    currency      TEXT NOT NULL DEFAULT 'INR',
    value_inr     REAL NOT NULL,                  -- round(qty * price * fx_rate, 2), computed on ingest
    avg_cost      REAL,
    invested_inr  REAL,
    UNIQUE (checkpoint_id, sleeve, symbol)
  );

  CREATE TABLE balances (
    id            INTEGER PRIMARY KEY,
    checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,                  -- cash | credit_card | epf | splitwise
    ref           TEXT NOT NULL,
    amount_inr    REAL NOT NULL,                  -- credit_card is stored positive = outstanding
    meta          TEXT,
    UNIQUE (checkpoint_id, kind, ref)
  );

  -- Standing rows: entered once, valued at every checkpoint.
  CREATE TABLE fixed_deposits (
    id            INTEGER PRIMARY KEY,
    bank          TEXT NOT NULL,
    principal     REAL NOT NULL,
    rate_pct      REAL NOT NULL,
    start_date    TEXT NOT NULL,
    maturity_date TEXT,
    closed_at     TEXT,
    compounding   TEXT NOT NULL DEFAULT 'quarterly',
    note          TEXT
  );
  CREATE TABLE splitwise_balances (
    person     TEXT PRIMARY KEY,
    amount_inr REAL NOT NULL,                     -- positive = they owe you
    note       TEXT,
    updated_at TEXT NOT NULL
  );

  -- Hand-entered positions with no MCP behind them (Bitcoin). Carried forward
  -- into every checkpoint taken on or after the date entered.
  CREATE TABLE manual_holdings (
    as_of_date   TEXT NOT NULL,
    sleeve       TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    name         TEXT,
    qty          REAL NOT NULL,
    price        REAL NOT NULL,
    avg_cost     REAL,
    invested_inr REAL,
    PRIMARY KEY (as_of_date, symbol)
  );

  CREATE TABLE wallet_accounts (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    account_type TEXT,
    currency     TEXT,
    last_seen_at TEXT
  );
  CREATE TABLE transactions (
    id           TEXT PRIMARY KEY,                -- Wallet's own record id: ingest is idempotent
    txn_date     TEXT NOT NULL,
    amount_inr   REAL NOT NULL,                   -- negative = expense
    currency     TEXT,
    account      TEXT,
    note         TEXT,
    category_id  TEXT,
    category     TEXT,
    category_top TEXT,
    is_transfer  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX transactions_date ON transactions (txn_date);
  CREATE TABLE transaction_labels (
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    label          TEXT NOT NULL,
    PRIMARY KEY (transaction_id, label)
  );

  CREATE TABLE trades (
    id           INTEGER PRIMARY KEY,
    sleeve       TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    exit_date    TEXT NOT NULL,
    invested_inr REAL NOT NULL,
    realised_inr REAL NOT NULL,
    holding_days INTEGER,
    source       TEXT,
    UNIQUE (sleeve, symbol, exit_date, invested_inr)
  );

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- JSON values

  -- Which files from data/ have been imported, so syncing twice is a no-op.
  CREATE TABLE imported_files (
    path        TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,                    -- size:mtime, re-imported when it changes
    imported_at TEXT NOT NULL
  );
  `,
]
