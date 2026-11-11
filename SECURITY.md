# Security

## Reporting a vulnerability

Please email adeyemoakinola2@gmail.com with the details and steps to reproduce. Do not open a public issue for a security problem. I aim to reply within three working days.

## What the service does

- **Authentication.** Every `/v1` route requires an API key. Only SHA-256 digests of keys are configured, and digests are compared in constant time.
- **Input validation.** Every body, path and query is validated against a strict schema. Unknown fields are rejected.
- **SQL injection.** All queries are parameterised. No SQL is built from request data.
- **Logging.** API keys and authorization headers are redacted from logs. Unhandled errors are logged in full and returned to the client as a generic message.
- **Abuse limits.** Requests are rate limited and bodies are capped at 1 MB.
- **Runtime.** The container runs as an unprivileged user and ships production dependencies only.

## What it expects from its surroundings

- **TLS.** Terminate TLS at a load balancer or reverse proxy in front of the service.
- **Network.** `/metrics`, `/healthz` and `/readyz` need no API key. Expose them to your monitoring network only.
- **Database access.** Give the service its own database role. The append-only triggers stop application bugs, not a superuser.
- **Secrets.** Supply `DATABASE_URL` and `API_KEY_HASHES` from a secret manager, not from a file in the image.
