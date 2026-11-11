-- An ordered feed of what happened in the ledger, written in the same database
-- transaction as the change it describes (the transactional outbox pattern).
CREATE TABLE ledger_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The database transaction that wrote the event. Readers use it to skip
  -- events whose transaction might still be overtaken by an older, slower one.
  txid        xid8 NOT NULL DEFAULT pg_current_xact_id(),
  type        text NOT NULL,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_events_txid_id_idx ON ledger_events (txid, id);

CREATE TRIGGER ledger_events_append_only
  BEFORE UPDATE OR DELETE ON ledger_events
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
