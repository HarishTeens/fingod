-- True rupee cost basis for US equity.
--
-- Until now `holdings.invested_inr` for us_equity came straight from
-- INDmoney's networth_holdings.invested_amount. Discovery showed that field is
-- a back-conversion of the USD cost at a FLAT 92.0000 — identical to four
-- decimal places on every holding, which no blend of real purchase-date
-- rates could produce. Actual ECB rates on the trade dates varied widely.
--
-- The effect was not cosmetic. The flat rate misstated cost and so
-- overstated the unrealised gain by roughly half.
--
-- So cost basis is now owned here, FIFO'd from the broker order book at the
-- rate that applied on each buy date, and INDmoney's invested_amount is
-- ignored. Current VALUE still comes from INDmoney every checkpoint — that one
-- is live and correct.

BEGIN;

-- The rate actually used to convert each trade, kept so a cost basis can be
-- re-derived and audited years later. Sourced from the ECB daily reference
-- series; `as_of` is the quote date, which is the preceding business day when
-- a trade fell on a weekend or holiday.
CREATE TABLE fx_rates (
    on_date  DATE           PRIMARY KEY,
    usd_inr  NUMERIC(16,8)  NOT NULL CHECK (usd_inr > 0),
    as_of    DATE           NOT NULL,
    source   TEXT           NOT NULL
);
COMMENT ON TABLE fx_rates IS
    'USD/INR used to convert a US trade on on_date. as_of may precede on_date '
    'when there was no quote that day (weekend, holiday).';

-- Standing cost basis per open US position. One row per symbol, replaced
-- wholesale by scripts/import-us-orders.py. /refresh reads invested_inr from
-- here instead of trusting INDmoney.
CREATE TABLE us_cost_basis (
    symbol      TEXT           PRIMARY KEY,
    qty         NUMERIC(28,10) NOT NULL CHECK (qty > 0),
    cost_usd    NUMERIC(20,2)  NOT NULL CHECK (cost_usd >= 0),
    cost_inr    NUMERIC(20,2)  NOT NULL CHECK (cost_inr >= 0),
    buy_rate    NUMERIC(16,8)  GENERATED ALWAYS AS
                    (CASE WHEN cost_usd > 0 THEN cost_inr / cost_usd END) STORED,
    first_buy   DATE,
    source      TEXT           NOT NULL DEFAULT 'indmoney-orders',
    updated_at  TIMESTAMPTZ    NOT NULL DEFAULT now()
);
COMMENT ON COLUMN us_cost_basis.buy_rate IS
    'Blended USD/INR actually paid. Compare against the live rate to see how '
    'much of a rupee return is the stock and how much is the currency.';
COMMENT ON COLUMN us_cost_basis.cost_usd IS
    'FIFO cost including brokerage. Reconciles to INDmoney invested_value_usd.';

-- USD cost, so a dollar-denominated return can be shown next to the rupee one.
-- Nullable: only us_equity rows carry it. The USD *value* needs no column —
-- for a currency='USD' holding it is qty * price, which holdings_value_consistent
-- already ties to value_inr.
ALTER TABLE holdings
    ADD COLUMN invested_usd NUMERIC(20,2)
        CHECK (invested_usd IS NULL OR invested_usd >= 0);
COMMENT ON COLUMN holdings.invested_usd IS
    'FIFO cost in USD (us_equity only). value_usd is qty * price.';

COMMIT;
