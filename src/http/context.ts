import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Client, Pool } from '../db/pool.js';
import { errors } from '../domain/errors.js';
import { fingerprint, runIdempotent, type StoredResponse } from '../ledger/idempotency.js';
import type { Metrics } from '../observability/metrics.js';
import { idempotencyKey } from './schemas.js';

/** What every route module needs. */
export interface RouteContext {
  pool: Pool;
  metrics: Metrics;
}

/**
 * Runs a write at most once for the request's `Idempotency-Key` and sends the
 * result, marking replays with an `Idempotent-Replayed` header. Returns whether
 * the response was a replay, so callers can skip side effects like metrics.
 */
export async function sendIdempotent(
  { pool, metrics }: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  work: (client: Client) => Promise<StoredResponse>,
): Promise<{ replayed: boolean }> {
  const key = idempotencyKey.safeParse(request.headers['idempotency-key']);
  if (!key.success) throw errors.idempotencyKeyRequired();

  const result = await runIdempotent(
    pool,
    key.data,
    fingerprint({ route, body: request.body ?? {} }),
    work,
  );
  if (result.replayed) {
    metrics.idempotentReplays.inc();
    void reply.header('idempotent-replayed', 'true');
  }
  await reply.status(result.status).send(result.body);
  return { replayed: result.replayed };
}
