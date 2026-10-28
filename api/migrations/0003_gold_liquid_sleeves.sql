-- Carve gold and liquid out of the Indian equity sleeve.
--
-- Kite returns them as ordinary equity holdings, but they are not equity:
-- GOLDBEES + GOLDCASE and LIQUIDBEES + LIQUIDCASE were a meaningful slice of
-- that feed. Booking the whole feed as in_equity overstated the sleeve and left the
-- rebalance table advising sales of equity that was never held.
--
-- Classification is per-symbol at ingest, keyed on ISIN. See docs/MCP-SHAPES.md.

BEGIN;

ALTER TABLE holdings          DROP CONSTRAINT holdings_sleeve_check;
ALTER TABLE corporate_actions DROP CONSTRAINT corporate_actions_sleeve_check;

ALTER TABLE holdings
    ADD CONSTRAINT holdings_sleeve_check
    CHECK (sleeve IN ('in_equity','in_mf','us_equity','gold','liquid','btc'));

ALTER TABLE corporate_actions
    ADD CONSTRAINT corporate_actions_sleeve_check
    CHECK (sleeve IN ('in_equity','in_mf','us_equity','gold','liquid','btc'));

-- Percentages must total 100. Gold and liquid are carved out of the previous
-- in_equity 40 rather than invented, so this stays exactly as provisional as it
-- was before — still a guess, still needs confirming (docs/HANDOFF.md, item 2).
UPDATE settings
   SET value = '{"in_equity":33,"in_mf":25,"us_equity":20,"gold":5,"liquid":2,"btc":5,"fd":10,"epf":0}'::jsonb,
       updated_at = now()
 WHERE key = 'target_allocation';

COMMIT;
