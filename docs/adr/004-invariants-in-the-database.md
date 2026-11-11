# 004: Enforce invariants in the database as well as the service

## Context

The service checks every rule before it writes: entries balance, accounts do not overdraw, history is not edited. But the service is not the only thing that can write to the database. Migrations, operators with a SQL prompt and future code paths can all bypass it.

## Decision

The rules that define a correct ledger are also enforced by PostgreSQL:

- A deferred constraint trigger verifies, at commit, that each transaction's entries balance per currency.
- A `CHECK` constraint on `accounts` rejects a negative balance unless the account allows it.
- Triggers reject `UPDATE` and `DELETE` on `entries` and `transactions`.
- Unique constraints make a reference postable once and a transaction reversible once.

## Consequences

- A bug in the service produces an error, not corrupt books.
- The service's own checks still run first, so callers get a specific error code and not a constraint name.
- The balance trigger runs once per inserted entry at commit. That is negligible for ordinary transactions and would need revisiting for transactions with thousands of entries.
- The tests assert these protections directly by writing to the tables behind the service's back.
