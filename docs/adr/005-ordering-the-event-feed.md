# 005: Order the event feed by transaction, not by id

## Context

Other services need to react to ledger changes: send a receipt, update a search index, notify a merchant. The ledger writes an event row in the same database transaction as each change, so an event exists if and only if its change committed. Consumers read the feed with a cursor.

The obvious cursor is the event's auto-incrementing id. It is wrong. Ids are assigned when a row is inserted, not when its transaction commits. If transaction A takes id 10 and is slow, while transaction B takes id 11 and commits first, a consumer reads 11 and moves its cursor past 10. When A commits, event 10 is behind the cursor and is never delivered.

## Decision

Each event records the id of the database transaction that wrote it (`pg_current_xact_id()`). The feed:

- orders events by `(transaction id, event id)`, and
- only returns events from transactions older than the oldest transaction still in flight (`pg_snapshot_xmin(pg_current_snapshot())`).

Anything a consumer has been shown can no longer be preceded by a late commit.

## Consequences

- Consumers see every event exactly once, in a stable order, with a plain cursor.
- An event becomes visible only after all older transactions finish. A long-running transaction anywhere in the database delays the feed. Transactions in this service are short, so the delay is normally milliseconds; a stuck transaction would show up as feed lag and should be alerted on.
- The cursor is opaque to clients. It encodes the transaction id and event id.
- Delivery is by polling. A consumer that needs lower latency can be woken with `LISTEN/NOTIFY` and still read through the same query.

## Alternatives considered

- **Order by id.** Skips events, as described above.
- **A lock that serialises all event inserts.** Correct, but turns every ledger write into a queue behind one lock.
- **Change data capture (Debezium to Kafka).** The right tool once several services consume the feed at volume. It reads the same table, so this design does not rule it out.
