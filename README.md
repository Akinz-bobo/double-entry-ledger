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
| Money is authorized now and taken later      | Holds reserve funds; capture moves them, void releases them                           |
| The provider's records and yours drift apart | A reconciliation endpoint lists every difference                                      |
| Other services must react to money moving    | An ordered event feed, written in the same transaction as each change                 |

## Guarantees

1. **Every transaction balances.** Debits equal credits for each currency, or nothing is written.
2. **Balances never drift.** An account's balance is derived from running totals updated in the same database transaction as the entries.
3. **No overdrafts,** unless an account is explicitly allowed to go negative.
4. **Posting is idempotent.** One `Idempotency-Key` produces one transaction, however many times it is sent, including concurrently.
5. **History is immutable.** `UPDATE` and `DELETE` on entries and transactions are rejected by the database.
6. **Held funds cannot be spent.** Postings and new holds are checked against the available balance: the balance less everything on hold.
7. **Events are never lost or skipped.** An event commits with its change, and the feed's ordering holds up against slow concurrent transactions.

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

Interactive documentation is served by the running service at **`/docs`** (Swagger UI), with the OpenAPI document at `/docs/json`. The source is [`openapi/openapi.yaml`](openapi/openapi.yaml). A test compares it with the routes the service really registers, so the two cannot drift apart.

All `/v1` routes require an `X-API-Key` header. Read-only keys can call the `GET` routes and run reconciliations.

| Method and path                               | Purpose                                                            |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `POST /v1/accounts`                           | Create an account                                                  |
| `GET /v1/accounts`                            | List accounts, with filters                                        |
| `GET /v1/accounts/:code`                      | Read an account with its balance, available balance and held funds |
| `GET /v1/accounts/:code/entries`              | Page through an account's history, newest first                    |
| `POST /v1/transactions`                       | Post a balanced transaction                                        |
| `GET /v1/transactions/:id`                    | Read a transaction and its entries                                 |
| `POST /v1/transactions/:id/reversals`         | Reverse a transaction                                              |
| `POST /v1/holds`                              | Reserve funds on an account                                        |
| `GET /v1/holds/:id`                           | Read a hold                                                        |
| `POST /v1/holds/:id/capture`                  | Capture all or part of a hold                                      |
| `POST /v1/holds/:id/void`                     | Release a hold                                                     |
| `POST /v1/reconciliations`                    | Compare an account's activity with an external statement           |
| `GET /v1/reports/trial-balance`               | Check that total debits equal total credits                        |
| `GET /v1/events`                              | Read the ordered event feed                                        |
| `GET /healthz`, `GET /readyz`, `GET /metrics` | Liveness, readiness and Prometheus metrics                         |

Every `POST` that changes the ledger needs an `Idempotency-Key` header. Errors share one shape:

```json
{
  "error": {
    "code": "insufficient_funds",
    "message": "Account wallet:alice cannot go below zero",
    "details": { "code": "wallet:alice" }
  }
}
```

### Postman collection

[`postman/`](postman) holds a collection that works as a guided tour and as an end-to-end test: 36 requests with assertions, covering deposits, safe retries, refunds, holds, reconciliation and the event feed.

- **In Postman:** import `postman/double-entry-ledger.postman_collection.json`, start the service with `make up`, and run the folders in order.
- **From the command line:** `make api-test`.

Each run uses fresh account codes, so it can be repeated against the same database. CI runs it against the built container on every push.

### Holds

```bash
# Reserve 15.00 on Alice's wallet
curl -s localhost:3000/v1/holds -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -H 'idempotency-key: auth-attempt-1' \
  -d '{"accountCode":"wallet:alice","amount":"1500","reference":"auth-1"}'

# Capture 12.00 of it to the merchant; the other 3.00 returns to the wallet
curl -s localhost:3000/v1/holds/<hold id>/capture -H 'x-api-key: dev-key' \
  -H 'content-type: application/json' -H 'idempotency-key: capture-attempt-1' \
  -d '{"destinationAccountCode":"merchant:shop","amount":"1200"}'
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

### Events

Call `GET /v1/events`, process the page, and call again with the `nextCursor` you were given. An empty page means you are caught up. Event types: `account.created`, `transaction.posted`, `transaction.reversed`, `hold.created`, `hold.captured`, `hold.voided`, `hold.expired`.

## How it is built

```
src/
  domain/          money and error types, no dependencies
  ledger/          accounts, posting rules, transactions, holds, events, idempotency
  reconciliation/  statement matching
  reports/         trial balance
  http/            Fastify app: routes, validation, auth, serialization, API docs
  db/              connection pool, transaction helper, migration runner
  observability/   Prometheus metrics
migrations/        plain SQL, applied in order
openapi/           the API description
postman/           the API collection and local environment
```

The rules for a valid posting live in one pure function, [`planPosting`](src/ledger/posting.ts), which takes entries and accounts and returns the change to apply. It does no I/O, so every rule has a fast unit test. The database layer around it handles locking and persistence.

The reasoning behind the main decisions is written up in [`docs/adr`](docs/adr):

- [001: Store money as integer minor units](docs/adr/001-money-as-integer-minor-units.md)
- [002: Lock account rows instead of using serializable isolation](docs/adr/002-row-locks-over-serializable.md)
- [003: Claim idempotency keys in the same transaction as the work](docs/adr/003-idempotency-in-the-same-transaction.md)
- [004: Enforce invariants in the database as well as the service](docs/adr/004-invariants-in-the-database.md)
- [005: Order the event feed by transaction, not by id](docs/adr/005-ordering-the-event-feed.md)
- [006: Model holds as reserved funds, not as transactions](docs/adr/006-holds-as-reserved-funds.md)

## Development

```bash
pnpm install
make db            # PostgreSQL on port 5544, with a test database
pnpm test          # unit and integration tests
make check         # format, lint, types, tests
make api-test      # the Postman collection, against `make up`
```

Integration tests run against a real PostgreSQL, not mocks, because the properties that matter here (locking, constraints, triggers) only exist in the database.

## Security

- API keys are configured as SHA-256 digests and compared in constant time
- Keys can be read-only, so reporting tools never hold a key that can move money
- Request bodies are validated strictly; unknown fields are rejected
- Security headers and rate limiting are on by default
- The container runs as an unprivileged user
- CI audits dependencies and runs CodeQL on every push; Dependabot keeps dependencies current

See [SECURITY.md](SECURITY.md) for how to report a vulnerability, and for what this service leaves to its surroundings.

## Scope

This is a reference implementation, built to show how I approach ledger design. It is complete and tested, but it has not handled production traffic. Things a production deployment would add: API keys stored per client with rotation, a relay that pushes the event feed to a message broker, archiving of old idempotency keys, and currency conversion.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how the code is organised and [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## Licence

MIT
