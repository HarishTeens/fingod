-- Splitwise receivables, per person.
--
-- Standing rows, not per-checkpoint. Splitwise itself stays the system of
-- record for who owes what and why; fingod only needs the bottom line per
-- person, updated whenever it drifts enough to matter. Asking for it at every
-- refresh would be re-typing a number that rarely changes.
--
-- A checkpoint snapshots whatever is here into balances(kind='splitwise'), so
-- history keeps the figure that was true at the time rather than back-applying
-- today's.

BEGIN;

CREATE TABLE splitwise_balances (
    person     TEXT          PRIMARY KEY,
    amount_inr NUMERIC(20,2) NOT NULL,   -- positive = owed TO you; negative = owed BY you
    note       TEXT,
    updated_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);
COMMENT ON COLUMN splitwise_balances.amount_inr IS
    'Positive means this person owes you. Negative means you owe them, and it '
    'reduces net worth — a receivable and a debt are the same column with a sign.';

COMMIT;
