# Double-Entry Ledger

[![CI](https://github.com/Akinz-bobo/double-entry-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/Akinz-bobo/double-entry-ledger/actions/workflows/ci.yml)

A ledger service for products that move money. It records every movement as a balanced set of debits and credits, refuses to lose or double-count a cent under concurrent load, and tells you when its books disagree with your payment provider's.

Built with TypeScript, Fastify and PostgreSQL.

## Why this exists

Most payment bugs are bookkeeping bugs: a retried request charges twice, two withdrawals race past the same balance check, a webhook is lost and nobody notices for a month. This service is a small, complete answer to those problems:

| Problem                                      | How the ledger handles it                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| A client retries a request after a timeout   | Idempotency keys: the retry gets the first response back, and nothing is posted twice |
| Two requests spend the same balance at once  | Account rows are locked in a fixed order for the length of each posting               |
| A bug writes one side of a movement          | Debits must equal credits, checked in code and again by a database trigger            |
| Someone edits history to "fix" a number      | Entries are append-only; corrections are reversals                                    |
| The provider's records and yours drift apart | A reconciliation endpoint lists every difference                                      |

## Guarantees

1. **Every transaction balances.** Debits equal credits for each currency, or nothing is written.
2. **Balances never drift.** An account's balance is derived from running totals updated in the same database transaction as the entries.
3. **No overdrafts,** unless an account is explicitly allowed to go negative.
4. **Posting is idempotent.** One `Idempotency-Key` produces one transaction, however many times it is sent, including concurrently.
5. **History is immutable.** `UPDATE` and `DELETE` on entries and transactions are rejected by the database.

Each guarantee is enforced twice: once in the service for a clear error, and once in PostgreSQL as a backstop. The [tests](test/integration/ledger.test.ts) exercise both, including races.

## Quick start

You need Docker.

```bash
make up
```

That starts PostgreSQL, applies the migrations and serves the API on `http://localhost:3000`. The local API key is `dev-key`.

```bash
# Create two accounts
curl -s localhost:3000/v1/accounts -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"code":"bank:cash","name":"Cash at bank","type":"asset","currency":"USD"}'
curl -s localhost:3000/v1/accounts -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"code":"wallet:alice","name":"Alice","type":"liability","currency":"USD"}'

# Record a $50.00 deposit into Alice's wallet
curl -s localhost:3000/v1/transactions -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -H 'idempotency-key: deposit-attempt-1' \
  -d '{
    "reference": "deposit-1",
    "entries": [
      {"accountCode": "bank:cash",    "direction": "debit",  "amount": "5000"},
      {"accountCode": "wallet:alice", "direction": "credit", "amount": "5000"}
    ]
  }'

# Read the balance
curl -s localhost:3000/v1/accounts/wallet:alice -H 'x-api-key: dev-key'
```

Amounts are whole numbers of minor units (cents, kobo), sent as strings.

## API

All `/v1` routes require an `X-API-Key` header.

| Method and path                       | Purpose                                                  |
| ------------------------------------- | -------------------------------------------------------- |
| `POST /v1/accounts`                   | Create an account                                        |
| `GET /v1/accounts/:code`              | Read an account and its balance                          |
| `GET /v1/accounts/:code/entries`      | Page through an account's history, newest first          |
| `POST /v1/transactions`               | Post a balanced transaction (needs `Idempotency-Key`)    |
| `GET /v1/transactions/:id`            | Read a transaction and its entries                       |
| `POST /v1/transactions/:id/reversals` | Reverse a transaction (needs `Idempotency-Key`)          |
| `POST /v1/reconciliations`            | Compare an account's activity with an external statement |
| `GET /healthz`, `GET /readyz`         | Liveness and readiness                                   |
| `GET /metrics`                        | Prometheus metrics                                       |

Errors share one shape:

```json
{
  "error": {
    "code": "insufficient_funds",
    "message": "Account wallet:alice cannot go below zero",
    "details": { "code": "wallet:alice" }
  }
}
```

### Reconciliation

Send the lines from a bank or provider statement and get back what differs from the ledger:

```json
{
  "balanced": false,
  "matched": 1,
  "amountMismatches": [{ "reference": "pay-2", "ledgerAmount": "700", "statementAmount": "650" }],
  "missingInLedger": [{ "reference": "pay-3", "amount": "100" }],
  "missingInStatement": [],
  "duplicateStatementReferences": []
}
```

## How it is built

```
src/
  domain/          money and error types, no dependencies
  ledger/          accounts, posting rules, transactions, idempotency
  reconciliation/  statement matching
  http/            Fastify app: routes, validation, auth, serialization
  db/              connection pool, transaction helper, migration runner
  observability/   Prometheus metrics
migrations/        plain SQL, applied in order
```

The rules for a valid posting live in one pure function, [`planPosting`](src/ledger/posting.ts), which takes entries and accounts and returns the change to apply. It does no I/O, so every rule has a fast unit test. The database layer around it handles locking and persistence.

The reasoning behind the main decisions is written up in [`docs/adr`](docs/adr):

- [001: Store money as integer minor units](docs/adr/001-money-as-integer-minor-units.md)
- [002: Lock account rows instead of using serializable isolation](docs/adr/002-row-locks-over-serializable.md)
- [003: Claim idempotency keys in the same transaction as the work](docs/adr/003-idempotency-in-the-same-transaction.md)
- [004: Enforce invariants in the database as well as the service](docs/adr/004-invariants-in-the-database.md)

## Development

```bash
pnpm install
make db            # PostgreSQL on port 5544, with a test database
pnpm test          # unit and integration tests
make check         # everything CI runs: format, lint, types, tests
```

Integration tests run against a real PostgreSQL, not mocks, because the properties that matter here (locking, constraints, triggers) only exist in the database.

## Security

- API keys are configured as SHA-256 digests and compared in constant time
- Request bodies are validated strictly; unknown fields are rejected
- Security headers and rate limiting are on by default
- The container runs as an unprivileged user
- CI audits dependencies on every push

See [SECURITY.md](SECURITY.md) for how to report a vulnerability, and for what this service leaves to its surroundings.

## Scope

This is a reference implementation, built to show how I approach ledger design. It is complete and tested, but it has not handled production traffic. Things a production deployment would add: per-client API keys with scopes, an outbox for publishing ledger events, archiving of old idempotency keys, and currency conversion.

## Licence

MIT
