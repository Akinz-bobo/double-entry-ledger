import { createHash } from 'node:crypto';
import { withTransaction, type Client, type Pool } from '../db/pool.js';
import { errors } from '../domain/errors.js';

export interface StoredResponse {
  status: number;
  body: unknown;
}

export interface IdempotentResult extends StoredResponse {
  /** True when the response came from an earlier request with the same key. */
  replayed: boolean;
}

/** A stable hash of a request, independent of the order of its JSON keys. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  // JSON.stringify returns undefined for values JSON cannot represent.
  return value === undefined ? 'null' : JSON.stringify(value);
}

/**
 * Runs `work` at most once per idempotency key.
 *
 * The key is claimed and the work done in a single database transaction, so
 * the ledger write and the record of its response commit together or not at
 * all. A second request with the same key blocks on the first one's row until
 * it finishes, then replays its stored response instead of running again.
 *
 * If `work` throws, nothing is stored and the key stays free, so the client
 * can safely retry after a failure.
 */
export async function runIdempotent(
  pool: Pool,
  key: string,
  requestHash: string,
  work: (client: Client) => Promise<StoredResponse>,
): Promise<IdempotentResult> {
  return withTransaction(pool, async (client) => {
    const claimed = await client.query(
      `INSERT INTO idempotency_keys (key, request_hash, response_status, response_body)
       VALUES ($1, $2, 0, 'null'::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [key, requestHash],
    );

    if (claimed.rowCount === 0) {
      const existing = await client.query<{
        request_hash: string;
        response_status: number;
        response_body: unknown;
      }>(
        'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = $1',
        [key],
      );
      const row = existing.rows[0];
      if (!row || row.request_hash !== requestHash) throw errors.idempotencyKeyReused();
      return { status: row.response_status, body: row.response_body, replayed: true };
    }

    const response = await work(client);
    await client.query(
      'UPDATE idempotency_keys SET response_status = $2, response_body = $3 WHERE key = $1',
      [key, response.status, JSON.stringify(response.body)],
    );
    return { ...response, replayed: false };
  });
}
