-- Count a deposit's principal as money in.
--
-- order_positions treated only `buy` as cash out and `sell` as cash in, so the
-- two fixed deposits reported 0 bought and 0 sold despite 7.2 lakh having very
-- definitely left the account. `open` and `close` are the deposit equivalents
-- and belong in the same columns; a sleeve whose money is invisible is worse
-- than one with no rows at all, because the first looks answered.

BEGIN;

CREATE OR REPLACE VIEW order_positions AS
SELECT sleeve,
       symbol,
       max(isin)       AS isin,
       max(name)       AS name,
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
       sum(CASE WHEN action IN ('buy', 'open')   THEN gross_inr + fees ELSE 0 END) AS bought_inr,
       sum(CASE WHEN action IN ('sell', 'close') THEN gross_inr - fees ELSE 0 END) AS sold_inr
  FROM orders
 GROUP BY sleeve, symbol;

COMMENT ON VIEW order_positions IS
    'Net quantity and cash the tape implies per instrument. buy/open are money '
    'out, sell/close money in; split, bonus, accrual and transfer move quantity '
    'only. Compare against a checkpoint via /api/v1/orders/reconcile.';

COMMIT;
