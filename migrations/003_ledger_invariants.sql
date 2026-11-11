-- The ledger is append-only. Corrections are made by posting a reversal,
-- never by editing history.
CREATE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: the ledger is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entries_append_only
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TRIGGER transactions_append_only
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- Debits must equal credits, per currency, for every transaction. The service
-- checks this before writing; this trigger is the last line of defence against
-- a bug or a manual insert. It is deferred so it runs once all of a
-- transaction's entries are in place, at commit.
CREATE FUNCTION assert_transaction_balanced() RETURNS trigger AS $$
DECLARE
  unbalanced_currency char(3);
BEGIN
  SELECT e.currency INTO unbalanced_currency
  FROM entries e
  WHERE e.transaction_id = NEW.transaction_id
  GROUP BY e.currency
  HAVING sum(CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END) <> 0
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'transaction % is not balanced for currency %',
      NEW.transaction_id, unbalanced_currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER entries_balanced
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced();
