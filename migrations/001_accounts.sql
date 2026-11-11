CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');

CREATE TABLE accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  name            text NOT NULL,
  type            account_type NOT NULL,
  currency        char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  allow_negative  boolean NOT NULL DEFAULT false,
  -- Running totals in minor units (cents, kobo). The balance is derived from
  -- these two columns, never stored, so it cannot drift from the entries.
  debits_posted   bigint NOT NULL DEFAULT 0 CHECK (debits_posted >= 0),
  credits_posted  bigint NOT NULL DEFAULT 0 CHECK (credits_posted >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Backstop for the overdraft check the service makes under a row lock.
  -- Assets and expenses are debit-normal; the rest are credit-normal.
  CONSTRAINT accounts_no_overdraft CHECK (
    allow_negative
    OR (CASE WHEN type IN ('asset', 'expense')
             THEN debits_posted - credits_posted
             ELSE credits_posted - debits_posted END) >= 0
  )
);
