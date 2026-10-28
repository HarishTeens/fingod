-- What a holding cost, so return is answerable from one checkpoint.
--
-- The qty-diff engine derives everything from consecutive snapshots, which is
-- right and stays the source of truth for *period* performance. But it needs two
-- checkpoints, and on day one there is one. Cost basis is the question it cannot
-- answer anyway — "how is this doing since I bought it" spans every checkpoint
-- that ever existed, including the ones taken before fingod did.
--
-- Both sources carry it already: Kite's `average_price` on equity and mutual
-- funds, INDmoney's `invested_amount` on US stocks.
--
-- Two columns rather than one, because they answer different questions:
--
--   avg_cost      per unit, in the holding's own currency. For display beside
--                 the current price — "bought at $131.60, now $615.17".
--   invested_inr  the rupees actually put in, at the exchange rates of the day
--                 they were put in. Authoritative for return, because deriving
--                 it as qty x avg_cost x today's fx would silently restate
--                 history every time the rupee moved.

BEGIN;

ALTER TABLE holdings
    ADD COLUMN avg_cost     NUMERIC(24,8) CHECK (avg_cost IS NULL OR avg_cost >= 0),
    ADD COLUMN invested_inr NUMERIC(20,2) CHECK (invested_inr IS NULL OR invested_inr >= 0);

COMMENT ON COLUMN holdings.avg_cost IS
    'Average cost per unit in the holding''s own currency. Display only — unreliable '
    'across corporate actions (LIQUIDBEES reads 51.99 against a 1,000.01 NAV).';
COMMENT ON COLUMN holdings.invested_inr IS
    'Rupees actually invested, at the rates of the day. Authoritative for return.';

COMMIT;
