# 002: Lock account rows instead of using serializable isolation

## Context

Two postings that touch the same account must not both read the old balance and both pass the overdraft check. PostgreSQL offers two ways to prevent that: `SERIALIZABLE` isolation, which aborts one of the conflicting transactions, or explicit row locks, which make one wait for the other.

## Decision

Each posting runs at the default `READ COMMITTED` level and locks the accounts it touches with `SELECT ... FOR UPDATE`, always in `id` order.

## Consequences

- Concurrent postings on the same account queue up. Under contention they wait; they do not fail and retry.
- Locking in a fixed order means two postings over the same pair of accounts cannot deadlock.
- The lock is held only for the posting itself: a few short statements.
- A very hot account (a platform fee account, say) becomes a queue. If that ever limits throughput, the usual fix is to post to several sub-accounts and sum them.

## Alternatives considered

- **`SERIALIZABLE`.** Correct, but under contention most attempts abort and retry, wasting work exactly when the system is busiest.
- **Optimistic version column.** Same retry storm, implemented by hand.

The transaction helper still retries on serialization failures and deadlocks, in case a future query introduces one.
