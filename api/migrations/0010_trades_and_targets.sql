-- Realised profit, and the targets that produce it.
--
-- Everything in fingod so far measures what is held. The owner sells when a target
-- is reached, so a large part of what has actually been made is in positions that
-- no longer exist — invisible to holdings, invisible to the qty-diff engine
-- (which sees a sale as an outflow, correctly, and has nothing to say about
-- whether it was a good one), and invisible to cost basis.
--
-- Closed trades carrying realised profit were being reported as exactly nothing.

BEGIN;

CREATE TABLE trades (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sleeve        TEXT          NOT NULL CHECK (sleeve IN ('in_equity','in_mf','us_equity','gold','debt','btc')),
    symbol        TEXT          NOT NULL,
    name          TEXT,
    isin          TEXT,

    -- Nullable on purpose. The imported US rows carry a quantity computed as
    -- an INR amount over a USD price, which is not a number of shares. Better
    -- absent than wrong: the money columns are what realised profit is made of.
    qty           NUMERIC(28,10) CHECK (qty IS NULL OR qty > 0),
    buy_price     NUMERIC(24,8)  CHECK (buy_price IS NULL OR buy_price >= 0),
    sell_price    NUMERIC(24,8)  CHECK (sell_price IS NULL OR sell_price >= 0),

    buy_date      DATE,
    exit_date     DATE          NOT NULL,
    holding_days  INTEGER       CHECK (holding_days IS NULL OR holding_days >= 0),

    invested_inr  NUMERIC(20,2) NOT NULL CHECK (invested_inr > 0),
    realised_inr  NUMERIC(20,2) NOT NULL,   -- negative is a loss, and they matter

    note          TEXT,
    source        TEXT          NOT NULL DEFAULT 'manual',
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),

    -- Re-importing the same journal must not double the profit. A second sale
    -- of the same stock on the same day for the same amount is not a thing.
    CONSTRAINT trades_unique UNIQUE (sleeve, symbol, exit_date, invested_inr)
);
CREATE INDEX trades_exit_date_idx ON trades (exit_date DESC);
CREATE INDEX trades_sleeve_idx    ON trades (sleeve, exit_date DESC);

COMMENT ON COLUMN trades.realised_inr IS
    'Profit in rupees, negative for a loss. Realised — the position is closed and '
    'this is not going to change.';

-- Standing rows, like fixed deposits: a target is a decision, not an
-- observation, so it does not belong to a checkpoint.
CREATE TABLE price_targets (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sleeve       TEXT          NOT NULL,
    symbol       TEXT          NOT NULL,
    isin         TEXT,
    target_price NUMERIC(24,8) NOT NULL CHECK (target_price > 0),
    currency     TEXT          NOT NULL DEFAULT 'INR',
    horizon      TEXT,                       -- "3y", "6-9m", as written
    note         TEXT,
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT price_targets_unique UNIQUE (sleeve, symbol)
);
COMMENT ON COLUMN price_targets.currency IS
    'The currency target_price is quoted in — matched against the holding''s own '
    'price, which is USD for US equity. Comparing a dollar target to a rupee price '
    'would read as 85x away.';

COMMIT;
