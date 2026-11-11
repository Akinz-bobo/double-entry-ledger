# Contributing

## Getting set up

You need Node.js 22, pnpm and Docker.

```bash
pnpm install
make db       # PostgreSQL on port 5544, with a test database
make check    # format, lint, types and the full test suite
```

## How the code is organised

| Folder                              | Holds                                     | May depend on    |
| ----------------------------------- | ----------------------------------------- | ---------------- |
| `src/domain`                        | Money and error types                     | Nothing          |
| `src/ledger`                        | The ledger's rules and its queries        | `domain`, `db`   |
| `src/reconciliation`, `src/reports` | Read-only analysis                        | `ledger`, `db`   |
| `src/http`                          | Routes, validation, auth, serialization   | Everything above |
| `src/db`                            | Connection pool, transactions, migrations | Nothing          |

Rules live in `src/ledger`, not in route handlers. A handler validates the request, calls the ledger and serializes the result.

## Making a change

1. **Write the test first** when fixing a bug, so the fix is proven.
2. **Database changes are new migrations.** Never edit a migration that has been merged; add the next numbered file.
3. **API changes touch three things:** the route, `openapi/openapi.yaml` and the Postman collection. A test fails if the spec and the routes disagree.
4. **Keep invariants in two places.** A rule the ledger depends on is checked in the service for a clear error and enforced in PostgreSQL as a backstop.
5. **Money is a `bigint` of minor units.** Never a `number`, never a float.

## Tests

- `pnpm test:unit` runs pure logic, with no database.
- `pnpm test:integration` runs against a real PostgreSQL. Concurrency behaviour is tested with real races, not mocks.
- `make api-test` runs the Postman collection against a running stack (`make up`).

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org): `feat(ledger): ...`, `fix(http): ...`, `docs: ...`. Say what changed in the subject and why in the body. Keep each commit to one idea.

## Pull requests

Fill in the template. CI must pass: formatting, lint, types, unit and integration tests, the API contract run, a dependency audit, CodeQL and the image build.
