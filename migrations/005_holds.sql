-- Funds reserved by pending holds. Available balance = balance - held.
ALTER TABLE accounts
  ADD COLUMN held bigint NOT NULL DEFAULT 0 CHECK (held >= 0);

-- The overdraft backstop now protects the available balance, not the total.
ALTER TABLE accounts DROP CONSTRAINT accounts_no_overdraft;
ALTER TABLE accounts ADD CONSTRAINT accounts_no_overdraft CHECK (
  allow_negative
  OR (CASE WHEN type IN ('asset', 'expense')
           THEN debits_posted - credits_posted
           ELSE credits_posted - debits_posted END) - held >= 0
);

CREATE TYPE hold_status AS ENUM ('pending', 'captured', 'voided', 'expired');

CREATE TABLE holds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        text NOT NULL UNIQUE,
  account_id       uuid NOT NULL REFERENCES accounts (id),
  amount           bigint NOT NULL CHECK (amount > 0),
  status           hold_status NOT NULL DEFAULT 'pending',
  expires_at       timestamptz,
  -- Set when the hold is captured.
  captured_amount  bigint CHECK (captured_amount > 0 AND captured_amount <= amount),
  transaction_id   uuid REFERENCES transactions (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,

  CONSTRAINT holds_capture_is_complete CHECK (
    (status = 'captured') = (transaction_id IS NOT NULL AND captured_amount IS NOT NULL)
  ),
  CONSTRAINT holds_resolution_is_recorded CHECK ((status = 'pending') = (resolved_at IS NULL))
);

-- Serves the expiry sweep, which only ever looks at pending holds with a deadline.
CREATE INDEX holds_pending_expiry_idx ON holds (expires_at)
  WHERE status = 'pending' AND expires_at IS NOT NULL;
