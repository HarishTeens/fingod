-- Let a closed insurance-linked investment be recorded as a trade.
--
-- An endowment policy: premiums paid over a few years, payouts back, then
-- redeemed. The realised result can be larger than every closed equity trade
-- combined, and until now it was recorded nowhere.
--
-- `insurance` is a trade sleeve but never a holdings sleeve: an endowment policy
-- has no quantity and no price, nothing to snapshot, and this one is closed. If
-- a live policy ever needs valuing it belongs with fixed deposits, as a standing
-- row valued by formula — not here.

BEGIN;

ALTER TABLE trades DROP CONSTRAINT trades_sleeve_check;
ALTER TABLE trades
    ADD CONSTRAINT trades_sleeve_check
    CHECK (sleeve IN ('in_equity','in_mf','us_equity','gold','debt','btc','insurance'));

COMMIT;
