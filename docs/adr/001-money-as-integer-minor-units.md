# 001: Store money as integer minor units

## Context

A ledger adds and compares amounts constantly. Binary floating point cannot represent most decimal fractions exactly (`0.1 + 0.2 !== 0.3`), so sums drift and equality checks fail.

## Decision

Every amount is a whole number of the currency's minor unit (cents, kobo), held as `bigint` in PostgreSQL and `BigInt` in the service. The API accepts and returns amounts as strings.

## Consequences

- Arithmetic is exact, and "debits equal credits" is a plain integer comparison.
- JSON numbers lose precision above 2^53, which is why amounts cross the API as strings.
- Callers must know each currency's minor unit. The ledger does not format or convert money.
- Amounts are capped at 10^17 per entry, which keeps account totals well inside a signed 64-bit integer.

## Alternatives considered

- **`numeric` with decimal places.** Exact, but invites fractional minor units and needs a decimal library on the JavaScript side.
- **Floats.** Rejected for the reasons above.
