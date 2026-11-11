import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { DomainError, errors } from '../domain/errors.js';
import { createAccount, getAccount, listAccountEntries } from '../ledger/accounts.js';
import { fingerprint, runIdempotent } from '../ledger/idempotency.js';
import { getTransaction, postTransaction, reverseTransaction } from '../ledger/transactions.js';
import { createMetrics, type Metrics } from '../observability/metrics.js';
import { reconcileAccount } from '../reconciliation/reconcile.js';
import { requireApiKey } from './auth.js';
import * as schemas from './schemas.js';
import {
  serializeAccount,
  serializeAccountEntry,
  serializeReport,
  serializeTransaction,
} from './serialize.js';

export interface AppDependencies {
  config: Pick<Config, 'API_KEY_HASHES' | 'RATE_LIMIT_MAX' | 'LOG_LEVEL'>;
  pool: Pool;
  metrics?: Metrics;
}

function readIdempotencyKey(request: FastifyRequest): string {
  const parsed = schemas.idempotencyKey.safeParse(request.headers['idempotency-key']);
  if (!parsed.success) throw errors.idempotencyKeyRequired();
  return parsed.data;
}

export async function buildApp({
  config,
  pool,
  metrics = createMetrics(),
}: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never write credentials to the logs.
      redact: ['req.headers["x-api-key"]', 'req.headers.authorization'],
    },
    bodyLimit: 1024 * 1024,
  });

  await app.register(helmet);
  await app.register(rateLimit, { max: config.RATE_LIMIT_MAX, timeWindow: '1 minute' });

  app.addHook('onResponse', (request, reply, done) => {
    metrics.httpRequestDuration.observe(
      {
        method: request.method,
        // The route pattern, not the URL, keeps label cardinality bounded.
        route: request.routeOptions.url ?? 'unmatched',
        status: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
    done();
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof DomainError) {
      return reply.status(error.status).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'validation_error',
          message: 'The request is not valid',
          details: {
            issues: error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        },
      });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const { message } = error as { message: string };
      return reply.status(status).send({ error: { code: 'bad_request', message } });
    }
    // Anything else is a bug or an outage. Log it in full, tell the client nothing.
    request.log.error({ err: error }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  // ---- operational endpoints (no API key; restrict these at the network level)
  app.get('/healthz', () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  app.get('/metrics', async (_request, reply) => {
    return reply
      .header('content-type', metrics.registry.contentType)
      .send(await metrics.registry.metrics());
  });

  // ---- ledger API
  await app.register(
    (v1, _options, done) => {
      v1.addHook('onRequest', requireApiKey(config.API_KEY_HASHES));

      const sendIdempotent = (
        reply: FastifyReply,
        result: { status: number; body: unknown; replayed: boolean },
      ) => {
        if (result.replayed) {
          metrics.idempotentReplays.inc();
          void reply.header('idempotent-replayed', 'true');
        }
        return reply.status(result.status).send(result.body);
      };

      v1.post('/accounts', async (request, reply) => {
        const body = schemas.createAccountBody.parse(request.body);
        const account = await createAccount(pool, body);
        return reply.status(201).send(serializeAccount(account));
      });

      v1.get('/accounts/:code', async (request) => {
        const { code } = schemas.accountParams.parse(request.params);
        return serializeAccount(await getAccount(pool, code));
      });

      v1.get('/accounts/:code/entries', async (request) => {
        const { code } = schemas.accountParams.parse(request.params);
        const query = schemas.entriesQuery.parse(request.query);
        const page = await listAccountEntries(pool, code, query);
        return {
          entries: page.entries.map(serializeAccountEntry),
          nextCursor: page.nextCursor?.toString() ?? null,
        };
      });

      v1.post('/transactions', async (request, reply) => {
        const key = readIdempotencyKey(request);
        const body = schemas.postTransactionBody.parse(request.body);
        const result = await runIdempotent(
          pool,
          key,
          fingerprint({ route: 'POST /v1/transactions', body: request.body }),
          async (client) => {
            const transaction = await postTransaction(client, body);
            return { status: 201, body: serializeTransaction(transaction) };
          },
        );
        if (!result.replayed) metrics.transactionsPosted.inc({ kind: 'posting' });
        return sendIdempotent(reply, result);
      });

      v1.get('/transactions/:id', async (request) => {
        const { id } = schemas.transactionParams.parse(request.params);
        return serializeTransaction(await getTransaction(pool, id));
      });

      v1.post('/transactions/:id/reversals', async (request, reply) => {
        const key = readIdempotencyKey(request);
        const { id } = schemas.transactionParams.parse(request.params);
        const body = schemas.reverseTransactionBody.parse(request.body ?? {});
        const result = await runIdempotent(
          pool,
          key,
          fingerprint({ route: `POST /v1/transactions/${id}/reversals`, body: request.body ?? {} }),
          async (client) => {
            const reversal = await reverseTransaction(client, id, body);
            return { status: 201, body: serializeTransaction(reversal) };
          },
        );
        if (!result.replayed) metrics.transactionsPosted.inc({ kind: 'reversal' });
        return sendIdempotent(reply, result);
      });

      v1.post('/reconciliations', async (request) => {
        const body = schemas.reconcileBody.parse(request.body);
        return serializeReport(await reconcileAccount(pool, body));
      });

      done();
    },
    { prefix: '/v1' },
  );

  return app;
}
