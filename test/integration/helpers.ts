import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, type Pool } from '../../src/db/pool.js';
import { buildApp } from '../../src/http/app.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://ledger:ledger@localhost:5544/ledger_test';

export const API_KEY = 'test-api-key';
const API_KEY_HASH = createHash('sha256').update(API_KEY).digest('hex');

export function createTestPool(): Pool {
  return createPool(TEST_DATABASE_URL, 20);
}

/** Empties every ledger table. TRUNCATE bypasses the append-only row triggers. */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE entries, transactions, accounts, idempotency_keys RESTART IDENTITY');
}

export async function createTestApp(pool: Pool): Promise<FastifyInstance> {
  return buildApp({
    pool,
    config: { API_KEY_HASHES: [API_KEY_HASH], RATE_LIMIT_MAX: 100_000, LOG_LEVEL: 'silent' },
  });
}

export const authHeaders = { 'x-api-key': API_KEY };

let keyCounter = 0;
export function idempotencyKey(): string {
  keyCounter += 1;
  return `test-key-${Date.now()}-${keyCounter}`;
}
