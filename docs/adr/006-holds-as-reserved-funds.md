# 006: Model holds as reserved funds, not as transactions

## Context

Payments often happen in two steps. A card is authorized, then captured days later, possibly for less. A withdrawal is requested, then confirmed or rejected by the bank. Between the two steps the money must not be spent elsewhere, but it has not moved yet.

## Decision

A hold reserves an amount on one account. It is a row in `holds` and a running `held` total on the account, not a ledger transaction.

- An account's **available balance** is its balance less `held`. Every posting and every new hold is checked against the available balance.
- **Capture** releases the reservation and posts a normal transaction for the captured amount, in one database transaction. Capturing less than the hold returns the difference.
- **Void** and **expiry** release the reservation and post nothing.

## Consequences

- The ledger only ever contains money that actually moved. A voided authorization leaves no entries to reverse.
- `balance` stays the accounting truth; `availableBalance` is what the customer can spend. Both come from the same account row, so they cannot disagree.
- The hold row is locked first when resolving it, which is what stops two captures, or a capture and a void, from both succeeding.
- Expiry needs a sweep. It runs on a timer in every instance and uses `SKIP LOCKED`, so instances do not block or double-process each other. Until the sweep runs, an expired hold still reserves funds, but it can no longer be captured.
- The overdraft constraint in the database covers held funds too, so a bug cannot reserve more than an account has.

## Alternatives considered

- **Post the hold as a transaction to a "pending" account, then move it again on capture.** Common, and it keeps everything in the ledger. But every authorization then writes entries, voids need compensating entries, and partial captures need three movements. The books fill with money that never moved.
