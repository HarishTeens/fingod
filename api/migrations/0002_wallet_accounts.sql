-- Wallet account classification.
--
-- Discovery against the live Wallet MCP showed there is no field that
-- identifies a fixed deposit: the FD account is typed `General`, and
-- isInvestmentAccount / excludeFromStats are false on every account. Type
-- alone therefore cannot decide what belongs in the cash total.
--
-- So classification is explicit and persisted. Ingest upserts every account it
-- sees with role = NULL, and the checkpoint is REFUSED while any account is
-- unclassified. Silently guessing would have put a large deposit into cash and
-- double-counted it against the manually tracked FD.

BEGIN;

CREATE TABLE wallet_accounts (
    id           TEXT        PRIMARY KEY,          -- Wallet's account uuid
    name         TEXT        NOT NULL,
    account_type TEXT        NOT NULL,             -- Wallet's own type: Cash, SavingAccount, CreditCard, Bonus, General…
    currency     TEXT        NOT NULL DEFAULT 'INR',
    role         TEXT        CHECK (role IN ('cash','credit_card','ignore')),
    role_note    TEXT,                             -- why, e.g. "FD — tracked manually with rate and tenure"
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON COLUMN wallet_accounts.role IS
    'NULL = unclassified; ingest refuses to build a checkpoint until every account has a role. '
    'cash counts toward net worth, credit_card is subtracted as outstanding, ignore is excluded entirely.';

-- Suggested default for a newly discovered account. Deliberately returns NULL
-- for General/unknown types so an FD can never default into cash.
CREATE FUNCTION wallet_default_role(account_type TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE account_type
        WHEN 'Cash'          THEN 'cash'
        WHEN 'SavingAccount' THEN 'cash'
        WHEN 'CreditCard'    THEN 'credit_card'
        ELSE NULL
    END;
$$;

CREATE INDEX wallet_accounts_unclassified_idx ON wallet_accounts (name) WHERE role IS NULL;

COMMIT;
