CREATE TABLE idempotency_keys (
  key              text PRIMARY KEY,
  -- Hash of the request the key was first used with. A retry must send the
  -- same request; a different one under the same key is a client bug.
  request_hash     text NOT NULL,
  response_status  integer NOT NULL,
  response_body    jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idempotency_keys_created_at_idx ON idempotency_keys (created_at);
