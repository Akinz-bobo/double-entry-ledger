CREATE TABLE transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The caller's own identifier (order id, provider reference). Unique, so
  -- the same business event can never be posted twice.
  reference    text NOT NULL UNIQUE,
  description  text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Set on a reversal, pointing at the transaction it undoes. Unique, so a
  -- transaction can be reversed at most once.
  reverses     uuid UNIQUE REFERENCES transactions (id),
  posted_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE entry_direction AS ENUM ('debit', 'credit');

CREATE TABLE entries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id  uuid NOT NULL REFERENCES transactions (id),
  account_id      uuid NOT NULL REFERENCES accounts (id),
  direction       entry_direction NOT NULL,
  amount          bigint NOT NULL CHECK (amount > 0),
  currency        char(3) NOT NULL
);

CREATE INDEX entries_transaction_id_idx ON entries (transaction_id);
-- Serves keyset pagination of an account's history, newest first.
CREATE INDEX entries_account_id_id_idx ON entries (account_id, id DESC);
