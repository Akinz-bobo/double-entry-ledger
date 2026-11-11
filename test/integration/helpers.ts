import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, type Pool } from '../../src/db/pool.js';
import { buildApp } from '../../src/http/app.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://ledger:ledger@localhost:5544/ledger_test';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const API_KEY = 'test-api-key';
export const READ_ONLY_API_KEY = 'test-read-only-key';

export function createTestPool(): Pool {
  return createPool(TEST_DATABASE_URL, 20);
}

/** Empties every ledger table. TRUNCATE bypasses the append-only row triggers. */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE holds, entries, transactions, accounts, idempotency_keys, ledger_events
     RESTART IDENTITY`,
  );
}

export async function createTestApp(
  pool: Pool,
  configure?: (app: FastifyInstance) => void,
): Promise<FastifyInstance> {
  return buildApp({
    configure,
    pool,
    config: {
      API_KEY_HASHES: [sha256(API_KEY), `${sha256(READ_ONLY_API_KEY)}:read`],
      RATE_LIMIT_MAX: 100_000,
      LOG_LEVEL: 'silent',
    },
  });
}

export const authHeaders = { 'x-api-key': API_KEY };
export const readOnlyHeaders = { 'x-api-key': READ_ONLY_API_KEY };

let keyCounter = 0;
export function idempotencyKey(): string {
  keyCounter += 1;
  return `test-key-${Date.now()}-${keyCounter}`;
}
