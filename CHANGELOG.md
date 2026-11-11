# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com), and the project uses [Semantic Versioning](https://semver.org).

## [0.2.0] - 2026-11-11

### Added

- **Holds.** Reserve funds on an account, then capture all or part of them, or void them. Holds can carry an expiry and are released automatically once it passes.
- **Available balance.** Accounts now report `availableBalance` and `held` alongside `balance`. Postings and holds are checked against the available balance.
- **Event feed.** `GET /v1/events` returns an ordered feed of every change, written in the same transaction as the change.
- **Read-only API keys.** A key configured as `<digest>:read` can query and run reports but cannot post.
- **Account listing** with filters and keyset pagination.
- **Trial balance report**, as an integrity check on the whole ledger.
- **Request ids.** Every response carries `X-Request-Id`; a well-formed inbound id is reused.
- **OpenAPI document and Swagger UI**, served at `/docs`, with a test that fails if the document and the routes disagree.
- **Postman collection** that doubles as an end-to-end test and runs in CI.
- CodeQL analysis, Dependabot, a contributing guide and a pull request template.

### Changed

- Routes are split into one module per resource.
- The overdraft constraint in the database now protects the available balance.

## [0.1.0] - 2026-11-11

### Added

- Accounts, balanced transactions and reversals.
- Idempotent posting with `Idempotency-Key`.
- Reconciliation against an external statement.
- Database-level enforcement of balanced transactions, append-only history and overdraft limits.
- API key authentication, rate limiting and security headers.
- Prometheus metrics, health checks, a container image and CI.
