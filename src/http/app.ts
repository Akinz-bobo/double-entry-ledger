import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { DomainError } from '../domain/errors.js';
import { createMetrics, type Metrics } from '../observability/metrics.js';
import { requireApiKey } from './auth.js';
import type { RouteContext } from './context.js';
import { accountRoutes } from './routes/accounts.js';
import { holdRoutes } from './routes/holds.js';
import { reportRoutes } from './routes/reports.js';
import { transactionRoutes } from './routes/transactions.js';

export interface AppDependencies {
  config: Pick<Config, 'API_KEY_HASHES' | 'RATE_LIMIT_MAX' | 'LOG_LEVEL'>;
  pool: Pool;
  metrics?: Metrics;
}

const REQUEST_ID = /^[\w.-]{1,128}$/;

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
    // Reuse the caller's request id when it is well formed, so one id follows
    // a request across services. Anything else gets a fresh one.
    genReqId: (request) => {
      const inbound = request.headers['x-request-id'];
      return typeof inbound === 'string' && REQUEST_ID.test(inbound) ? inbound : randomUUID();
    },
  });

  await app.register(helmet);
  await app.register(rateLimit, { max: config.RATE_LIMIT_MAX, timeWindow: '1 minute' });

  app.addHook('onRequest', (request, reply, done) => {
    void reply.header('x-request-id', request.id);
    done();
  });

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
  const context: RouteContext = { pool, metrics };
  await app.register(
    (v1, _options, done) => {
      v1.addHook('onRequest', requireApiKey(config.API_KEY_HASHES));
      accountRoutes(v1, context);
      transactionRoutes(v1, context);
      holdRoutes(v1, context);
      reportRoutes(v1, context);
      done();
    },
    { prefix: '/v1' },
  );

  return app;
}
