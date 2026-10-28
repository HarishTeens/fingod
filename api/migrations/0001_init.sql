-- fingod initial schema.
--
-- Money is NUMERIC everywhere, never float. Two ideas drive the shape:
--
--  1. A *checkpoint* is an immutable snapshot of every position at one date.
--     Growth is never read from a price feed; it is derived by diffing
--     consecutive checkpoints and watching quantity (see compute/qtydiff).
--  2. Anything whose value is computable at an arbitrary date is stored as a
--     standing row, not snapshotted — fixed deposits being the case in point.
--     That way an FD entered today still values correctly at past checkpoints.

BEGIN;

-- ---------------------------------------------------------------- checkpoints

CREATE TABLE checkpoints (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    as_of_date DATE          NOT NULL UNIQUE,
    taken_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    usd_inr    NUMERIC(12,6) NOT NULL CHECK (usd_inr > 0),
    -- Per-source health, e.g. {"wallet":"ok","kite":"ok","indmoney":"stale"}.
    -- A stale sleeve is carried forward and excluded from attribution rather
    -- than being booked as a move to zero.
    sources    JSONB         NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);
COMMENT ON TABLE checkpoints IS 'One immutable snapshot of all positions, taken weekly or on demand.';
CREATE INDEX checkpoints_as_of_date_desc_idx ON checkpoints (as_of_date DESC);

-- ------------------------------------------------------------------ holdings

-- Sleeves with a quantity. FD and EPF have no qty and live in balances /
-- fixed_deposits instead.
CREATE TABLE holdings (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    checkpoint_id BIGINT        NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
    sleeve        TEXT          NOT NULL CHECK (sleeve IN ('in_equity','in_mf','us_equity','btc')),
    symbol        TEXT          NOT NULL,
    name          TEXT,
    isin          TEXT,
    qty           NUMERIC(28,10) NOT NULL CHECK (qty >= 0),
    price         NUMERIC(24,8)  NOT NULL CHECK (price >= 0),   -- per unit, in `currency`
    currency      TEXT           NOT NULL DEFAULT 'INR',
    fx_rate       NUMERIC(16,8)  NOT NULL DEFAULT 1 CHECK (fx_rate > 0), -- currency → INR at this checkpoint
    value_inr     NUMERIC(20,2)  NOT NULL,

    CONSTRAINT holdings_unique UNIQUE (checkpoint_id, sleeve, symbol),

    -- The whole growth engine rests on value == qty x price x fx being exact,
    -- so the ingest computes it rather than trusting the broker's rounded
    -- total. This guard fails loudly if that ever drifts.
    CONSTRAINT holdings_value_consistent
        CHECK (abs(value_inr - qty * price * fx_rate) <= 1.00)
);
COMMENT ON COLUMN holdings.fx_rate IS 'Native currency to INR at this checkpoint; 1 for INR sleeves. Enables the FX term in the qty-diff decomposition.';
CREATE INDEX holdings_checkpoint_sleeve_idx ON holdings (checkpoint_id, sleeve);
CREATE INDEX holdings_symbol_idx            ON holdings (sleeve, symbol);

-- ------------------------------------------------------------------ balances

-- Positions with no quantity: bank cash, credit-card debt, EPF, Splitwise.
CREATE TABLE balances (
    id            BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    checkpoint_id BIGINT        NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
    kind          TEXT          NOT NULL CHECK (kind IN ('cash','credit_card','epf','splitwise')),
    ref           TEXT          NOT NULL,          -- account name / person
    amount_inr    NUMERIC(20,2) NOT NULL,          -- credit_card is POSITIVE = outstanding
    meta          JSONB         NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT balances_unique UNIQUE (checkpoint_id, kind, ref),
    CONSTRAINT balances_credit_card_positive
        CHECK (kind <> 'credit_card' OR amount_inr >= 0)
);
COMMENT ON COLUMN balances.amount_inr IS 'Credit card stored positive as outstanding debt; subtracted in the networth formula.';
CREATE INDEX balances_checkpoint_kind_idx ON balances (checkpoint_id, kind);

-- ------------------------------------------------------------ fixed deposits

-- Standing rows, deliberately NOT per-checkpoint: principal and accrued
-- interest are computable at any date from rate + start date, so an FD added
-- today values correctly at every historical checkpoint.
-- Wallet's own FD accounts are excluded at ingest so these cannot double-count.
CREATE TABLE fixed_deposits (
    id            BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bank          TEXT          NOT NULL,
    principal     NUMERIC(20,2) NOT NULL CHECK (principal > 0),
    rate_pct      NUMERIC(7,4)  NOT NULL CHECK (rate_pct >= 0),
    start_date    DATE          NOT NULL,
    maturity_date DATE          NOT NULL,
    closed_at     DATE,                            -- NULL = still running
    compounding   TEXT          NOT NULL DEFAULT 'quarterly'
                                CHECK (compounding IN ('quarterly','simple')),
    note          TEXT,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT fd_matures_after_start CHECK (maturity_date > start_date)
);
CREATE INDEX fd_active_idx ON fixed_deposits (start_date) WHERE closed_at IS NULL;

-- -------------------------------------------------------------- transactions

CREATE TABLE transactions (
    id           TEXT          PRIMARY KEY,        -- Wallet's own uuid; makes ingest idempotent
    txn_date     DATE          NOT NULL,
    amount_inr   NUMERIC(20,2) NOT NULL,           -- negative = expense, positive = income
    currency     TEXT          NOT NULL DEFAULT 'INR',
    account      TEXT,
    payee        TEXT,
    note         TEXT,
    category_id  TEXT,
    category     TEXT,                             -- leaf, e.g. "Groceries"
    category_top TEXT,                             -- parent,  e.g. "Food & Drinks"
    is_transfer  BOOLEAN       NOT NULL DEFAULT false,  -- excluded from expense aggregation
    raw          JSONB         NOT NULL DEFAULT '{}'::jsonb,
    ingested_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX transactions_date_idx     ON transactions (txn_date DESC);
CREATE INDEX transactions_category_idx ON transactions (category_top, category);
CREATE INDEX transactions_expense_idx  ON transactions (txn_date DESC) WHERE NOT is_transfer;

-- Labels are many-to-many, so label sums legitimately exceed a period total and
-- untagged spend exists. Breakdowns must always emit an "Untagged" row and
-- never present labels as a partition of spend.
CREATE TABLE transaction_labels (
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    label          TEXT NOT NULL,
    PRIMARY KEY (transaction_id, label)
);
CREATE INDEX transaction_labels_label_idx ON transaction_labels (label);

-- ---------------------------------------------------------- corporate actions

-- Splits and bonus issues raise qty with no money in, which the qty-diff engine
-- would otherwise read as a large inflow. A row here neutralises that.
CREATE TABLE corporate_actions (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sleeve         TEXT   NOT NULL CHECK (sleeve IN ('in_equity','in_mf','us_equity','btc')),
    symbol         TEXT   NOT NULL,
    effective_date DATE   NOT NULL,
    kind           TEXT   NOT NULL CHECK (kind IN ('split','bonus','merger','other')),
    ratio          NUMERIC(16,8) NOT NULL CHECK (ratio > 0),  -- new qty / old qty, e.g. 2 for a 1:1 bonus
    note           TEXT,
    UNIQUE (sleeve, symbol, effective_date, kind)
);

-- ------------------------------------------------------------------ settings

CREATE TABLE settings (
    key        TEXT        PRIMARY KEY,
    value      JSONB       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Target allocation drives the rebalance drift table. Percentages, must total 100.
INSERT INTO settings (key, value) VALUES
    ('target_allocation', '{"in_equity":40,"in_mf":25,"us_equity":20,"btc":5,"fd":10,"epf":0}'::jsonb),
    ('fd_compounding',    '"quarterly"'::jsonb),
    ('base_currency',     '"INR"'::jsonb),
    -- Single-holding flow above this share of its sleeve gets flagged for review
    -- as a possible unrecorded corporate action.
    ('flow_flag_threshold', '0.25'::jsonb);

COMMIT;
