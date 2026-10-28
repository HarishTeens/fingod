-- The tape: every event that ever changed a quantity, for every asset class.
--
-- Until now fingod stored only derived aggregates — holdings.avg_cost from
-- Kite, us_cost_basis from a FIFO pass, trades from another. All three are
-- answers with no working shown, so a wrong one could not be found, only
-- believed. The orders table is the working.
--
-- Reconciling the Zerodha tape against live holdings immediately turned up
-- three things no aggregate could have revealed:
--
--   a split          tape 11, held 55 — the extra shares were never bought,
--                                       so any cost basis derived from buys
--                                       alone would be 5x too high
--   a unit dividend  tape  0, held  1 — daily dividend paid in units, which is
--                                       not a trade and appears in no tradebook
--   a vanished share tape  1, held  0 — bought 4, sold 3, and the last share
--                                       left by some route the export does not show
--
-- Those are exactly the events that corrupt a cost basis silently, which is
-- why `action` is wider than buy/sell: a split or an accrual moves quantity
-- without moving money, and a schema that cannot say so forces the importer to
-- either lie or drop the row.
--
-- Deliberately NOT the source of truth for cost basis yet. Kite's own
-- average_price already accounts for splits and for purchases predating this
-- tape (it starts 2021-11-24), so it stays authoritative for Indian sleeves.
-- This table's first job is to make disagreement visible.
--
-- Not to be confused with corporate_actions, which already exists and stays.
-- That table holds a RATIO (new qty / old qty) and exists to stop the qty-diff
-- engine reading a bonus issue as a large inflow between two checkpoints. This
-- one holds ABSOLUTE quantities and answers a different question: what is the
-- full history of this position. A split appears in both — as a ratio there,
-- as the concrete share count here — because neither form substitutes for the
-- other.

BEGIN;

CREATE TABLE orders (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Where the row came from, and that source's own id for it. Zerodha gives
    -- a trade_id per fill (33 of 268 orders were split across several), so the
    -- fill is the grain, not the order. Manual rows carry a synthetic id built
    -- by the importer so a re-run updates rather than duplicates.
    source      TEXT NOT NULL,
    external_id TEXT NOT NULL,

    -- Wider than holdings.sleeve: deposits, EPF and insurance all have a
    -- history worth keeping even though they are not priced holdings.
    sleeve      TEXT NOT NULL CHECK (sleeve IN (
                    'in_equity', 'in_mf', 'us_equity', 'gold', 'debt', 'btc',
                    'fd', 'epf', 'insurance')),
    symbol      TEXT NOT NULL,
    isin        TEXT,
    name        TEXT,

    action      TEXT NOT NULL CHECK (action IN (
                    -- money moves, quantity moves
                    'buy', 'sell',
                    -- quantity moves, money does not: corporate actions and
                    -- in-kind payouts. price is 0 and cost basis is unchanged.
                    'split', 'bonus', 'accrual', 'transfer_in', 'transfer_out',
                    -- deposits, which have a principal rather than a price
                    'open', 'close')),

    trade_date  DATE NOT NULL,

    -- Always positive; `action` carries the direction. A signed quantity plus
    -- a direction word is two sources of truth for one fact.
    qty         NUMERIC(28,10) NOT NULL CHECK (qty > 0),

    -- Per unit in `currency`. Zero for the non-cash actions above, and for a
    -- deposit it is the principal with qty 1.
    price       NUMERIC(24,8)  NOT NULL DEFAULT 0 CHECK (price >= 0),
    currency    TEXT           NOT NULL DEFAULT 'INR',
    fx_rate     NUMERIC(16,8)  NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
    fees        NUMERIC(20,2)  NOT NULL DEFAULT 0 CHECK (fees >= 0),

    -- What actually left or entered the account, in rupees, at that day's rate.
    -- Generated rather than supplied: it is a fact about the other columns, and
    -- an importer that computed it itself could disagree with them.
    gross_inr   NUMERIC(20,2) GENERATED ALWAYS AS
                    (round(qty * price * fx_rate, 2)) STORED,

    order_id    TEXT,
    exchange    TEXT,
    note        TEXT,
    raw         JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (source, external_id)
);

COMMENT ON TABLE orders IS
    'Every quantity-changing event, all asset classes. Buy/sell move money; '
    'split/bonus/accrual/transfer move only quantity; open/close are deposits. '
    'Re-import is idempotent on (source, external_id).';
COMMENT ON COLUMN orders.qty IS
    'Always positive. Direction lives in action, so the two can never disagree.';
COMMENT ON COLUMN orders.price IS
    'Per unit in currency. 0 for non-cash actions; for a deposit, the principal with qty 1.';

CREATE INDEX orders_sleeve_date_idx ON orders (sleeve, trade_date DESC);
CREATE INDEX orders_isin_idx        ON orders (isin) WHERE isin IS NOT NULL;
CREATE INDEX orders_symbol_idx      ON orders (sleeve, symbol, trade_date);

-- Net quantity per instrument implied by the tape. This is what gets compared
-- against a checkpoint's holdings; a disagreement is a corporate action, a
-- missing export, or an in-kind payout, and all three are worth knowing about.
CREATE VIEW order_positions AS
SELECT sleeve,
       symbol,
       max(isin)      AS isin,
       max(name)      AS name,
       min(trade_date) AS first_trade,
       max(trade_date) AS last_trade,
       count(*)        AS events,
       sum(CASE action
             WHEN 'buy'   THEN qty  WHEN 'sell'         THEN -qty
             WHEN 'bonus' THEN qty  WHEN 'accrual'      THEN  qty
             WHEN 'split' THEN qty  WHEN 'transfer_in'  THEN  qty
             WHEN 'open'  THEN qty  WHEN 'transfer_out' THEN -qty
             WHEN 'close' THEN -qty
           END) AS net_qty,
       -- Cash in and out, so a sanity check on money is available beside the
       -- one on quantity.
       sum(CASE WHEN action = 'buy'  THEN gross_inr + fees ELSE 0 END) AS bought_inr,
       sum(CASE WHEN action = 'sell' THEN gross_inr - fees ELSE 0 END) AS sold_inr
  FROM orders
 GROUP BY sleeve, symbol;

COMMENT ON VIEW order_positions IS
    'Net quantity the tape implies per instrument. Compare against a '
    'checkpoint via /api/v1/orders/reconcile — a mismatch is a real event, '
    'not noise.';

COMMIT;
