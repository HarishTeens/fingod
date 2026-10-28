-- Bank balances come from Wallet. Only from Wallet.
--
-- Migration 0006 pointed the salary account at INDmoney's bank-linked SA row,
-- because Wallet's manually maintained running total sat well below it.
-- The owner's call is that Wallet is the source for cash regardless — one
-- provider for the whole category, rather than a per-account mix whose
-- provenance you have to remember.
--
-- The balance_source column stays. It costs nothing dormant, the checks still
-- hold, and the decision is a row rather than a schema change if it is ever
-- revisited. What it must not do is stay switched on by default.
--
-- Consequence, recorded rather than argued: net worth follows Wallet's figure,
-- so any drift between the running total and the real bank balance is carried.
-- Reconciling in Wallet fixes it at the source, which is the right place.

BEGIN;

UPDATE wallet_accounts
   SET balance_source = 'wallet',
       external_ref   = NULL,
       role_note      = 'Salary account. Balance from Wallet by explicit choice — '
                        'INDmoney''s bank-linked figure was tried and rejected.',
       updated_at     = now()
 WHERE balance_source <> 'wallet';

COMMIT;
