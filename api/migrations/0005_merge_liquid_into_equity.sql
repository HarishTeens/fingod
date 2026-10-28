-- Fold the liquid sleeve back into Indian equity.
--
-- Migration 0003 carved out both gold and liquid on the same reasoning: Kite
-- delivers them through get_holdings as ordinary equity, and neither is equity.
-- That still holds for gold, which is a real allocation target that moves on
-- its own logic. It does not hold for liquid: LIQUIDCASE and LIQUIDBEES are
-- overnight-rate ETFs, i.e. cash parked in the demat account, and the owner's call
-- is that they do not warrant a sleeve of their own — a sleeve with a 0% target
-- only ever produces a drift row telling you to spend money you are holding on
-- purpose.
--
-- Existing rows move rather than being deleted, so no checkpoint loses value.

BEGIN;

UPDATE holdings          SET sleeve = 'in_equity' WHERE sleeve = 'liquid';
UPDATE corporate_actions SET sleeve = 'in_equity' WHERE sleeve = 'liquid';

ALTER TABLE holdings          DROP CONSTRAINT holdings_sleeve_check;
ALTER TABLE corporate_actions DROP CONSTRAINT corporate_actions_sleeve_check;

ALTER TABLE holdings
    ADD CONSTRAINT holdings_sleeve_check
    CHECK (sleeve IN ('in_equity','in_mf','us_equity','gold','btc'));

ALTER TABLE corporate_actions
    ADD CONSTRAINT corporate_actions_sleeve_check
    CHECK (sleeve IN ('in_equity','in_mf','us_equity','gold','btc'));

-- Drop the liquid target. It was 0, so nothing needs redistributing and the
-- percentages still total 100.
UPDATE settings
   SET value = value - 'liquid',
       updated_at = now()
 WHERE key = 'target_allocation';

COMMIT;
