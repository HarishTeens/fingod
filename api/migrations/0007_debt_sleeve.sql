-- Split the Zerodha debt holdings out of Indian equity.
--
-- LIQUIDCASE and LIQUIDBEES track the Nifty 1-Day Rate. Migration 0003 gave
-- them a sleeve called `liquid`, 0005 merged them back into `in_equity` on the
-- grounds that they are parked cash — and that was the wrong frame. They are
-- debt instruments held in the demat account, a different asset class from
-- equity with a target of its own. The parked-cash idea belongs to the bank
-- balances, which now carry the name `liquid` in the allocation table instead.
--
-- Rows move rather than being dropped, so no checkpoint loses value.

BEGIN;

ALTER TABLE holdings          DROP CONSTRAINT holdings_sleeve_check;
ALTER TABLE corporate_actions DROP CONSTRAINT corporate_actions_sleeve_check;

ALTER TABLE holdings
    ADD CONSTRAINT holdings_sleeve_check
    CHECK (sleeve IN ('in_equity','in_mf','us_equity','gold','debt','btc'));

ALTER TABLE corporate_actions
    ADD CONSTRAINT corporate_actions_sleeve_check
    CHECK (sleeve IN ('in_equity','in_mf','us_equity','gold','debt','btc'));

-- Keyed on ISIN, which survives a ticker rename.
UPDATE holdings SET sleeve = 'debt'
 WHERE sleeve = 'in_equity'
   AND isin IN ('INF0R8F01034',   -- LIQUIDCASE, Zerodha Nifty 1D Rate Liquid ETF
                'INF732E01037');  -- LIQUIDBEES, Nippon India Nifty 1D Rate Liquid BeES

COMMIT;
