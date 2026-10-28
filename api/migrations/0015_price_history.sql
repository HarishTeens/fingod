-- Daily closes, so performance can be reconstructed rather than only observed.
--
-- Checkpoints record what things were worth on the days a refresh happened —
-- two dates so far. That is enough for a net worth line and nowhere near enough
-- to answer "did my small-cap fund beat the Nifty since 2022". The order tape
-- already knows the quantity held on any date back to 2021-11-24; pair it with
-- a daily close and every historical value becomes derivable.
--
-- Benchmarks live in the same table under an IDX: key. A Nifty 50 series is
-- structurally identical to an instrument's — a date and a level — and giving
-- it its own table would mean writing every query twice.

BEGIN;

CREATE TABLE price_history (
    -- ISIN where the instrument has one (tickers get renamed; ISINs do not),
    -- IDX:<name> for an index, and the bare symbol only as a last resort.
    instrument TEXT NOT NULL,
    on_date    DATE NOT NULL,
    close      NUMERIC(24,8) NOT NULL CHECK (close >= 0),
    currency   TEXT NOT NULL DEFAULT 'INR',
    source     TEXT NOT NULL,
    PRIMARY KEY (instrument, on_date)
);

COMMENT ON TABLE price_history IS
    'Daily closes for owned instruments and benchmark indices alike. Paired '
    'with the order tape this makes any historical position value derivable, '
    'which is what a performance comparison needs and checkpoints cannot give.';
COMMENT ON COLUMN price_history.instrument IS
    'ISIN, or IDX:<name> for a benchmark, or a bare symbol when there is no ISIN.';

CREATE INDEX price_history_date_idx ON price_history (on_date);

-- The benchmarks a portfolio gets measured against. A row here is a claim that
-- the series is worth fetching and keeping current; the UI reads its label and
-- ordering from this rather than hardcoding three names in JavaScript.
CREATE TABLE benchmarks (
    key         TEXT PRIMARY KEY,          -- matches price_history.instrument
    label       TEXT NOT NULL,
    -- Kite's own tradingsymbol for the index, needed by get_historical_data.
    kite_symbol TEXT,
    exchange    TEXT NOT NULL DEFAULT 'NSE',
    sort_order  INT  NOT NULL DEFAULT 0
);

INSERT INTO benchmarks (key, label, kite_symbol, sort_order) VALUES
    ('IDX:NIFTY50',      'Nifty 50',           'NIFTY 50',           1),
    ('IDX:MIDCAP150',    'Nifty Midcap 150',   'NIFTY MIDCAP 150',   2),
    ('IDX:SMALLCAP250',  'Nifty Smallcap 250', 'NIFTY SMLCAP 250',   3);

COMMENT ON TABLE benchmarks IS
    'Indices the portfolio is compared against. kite_symbol is what '
    'get_historical_data expects and is not always the obvious spelling.';

COMMIT;
