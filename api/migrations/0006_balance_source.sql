-- Let a Wallet account take its balance from somewhere better.
--
-- None of the eight Wallet accounts is bank-synced (isBankSync: false on every
-- one), so each balance is a running total of manually entered records:
-- initial + income - expenses. Over years of records a salary
-- account drifted far below the real bank balance, and net worth was understated
-- by the same amount.
--
-- INDmoney links to the bank directly, so its SA row is the true balance. The
-- split is now: Wallet owns the account's *transactions*, which are what the
-- expense views are built from and which are entered correctly; INDmoney owns
-- its *balance*.
--
-- Per-account and explicit, like `role`. Nothing is inferred — a name match
-- between two providers is a coincidence until a human says otherwise.

BEGIN;

ALTER TABLE wallet_accounts
    ADD COLUMN balance_source TEXT NOT NULL DEFAULT 'wallet'
        CHECK (balance_source IN ('wallet', 'indmoney')),
    ADD COLUMN external_ref   TEXT;

COMMENT ON COLUMN wallet_accounts.balance_source IS
    'Where this account''s balance comes from at checkpoint time. wallet = the '
    'running total Wallet computes; indmoney = the bank-linked balance of the '
    'INDmoney SA row named by external_ref.';

ALTER TABLE wallet_accounts
    ADD CONSTRAINT wallet_accounts_external_ref_required
    CHECK (balance_source = 'wallet' OR external_ref IS NOT NULL);

UPDATE wallet_accounts
   SET balance_source = 'indmoney',
       external_ref   = 'Primary bank',
       role_note      = COALESCE(role_note || ' · ', '') ||
                        'Salary account. Balance from INDmoney (bank-linked); '
                        'Wallet''s manual running total had drifted low.',
       updated_at     = now()
 WHERE name = 'Salary account';

COMMIT;
