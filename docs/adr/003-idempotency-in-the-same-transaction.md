# 003: Claim idempotency keys in the same transaction as the work

## Context

Clients retry when a request times out, and they cannot know whether the first attempt was applied. Without protection, a retried deposit is posted twice.

## Decision

Posting endpoints require an `Idempotency-Key` header. The key is inserted into `idempotency_keys` in the same database transaction that posts to the ledger and stores the response.

- If the key is new, the work runs and its response is saved under the key.
- If the key exists with the same request hash, the saved response is returned.
- If the key exists with a different request hash, the request is rejected with `422`.

## Consequences

- The ledger write and the record of its response commit together or not at all. There is no window in which one exists without the other.
- A concurrent duplicate blocks on the first request's uncommitted row, then sees the committed response and replays it. No "in progress" state is needed.
- If the work fails, the transaction rolls back and the key is released, so the client can retry the same key after fixing the problem.
- Keys accumulate. A production deployment would delete keys older than its retry window; the `created_at` index is there for that.

## Alternatives considered

- **A cache such as Redis in front of the database.** Faster, but the key and the ledger write can then disagree after a crash, which is the exact failure idempotency exists to prevent.
- **Relying on the unique `reference` alone.** It stops the double posting but returns an error on retry, so the client cannot tell a retry from a real conflict.
