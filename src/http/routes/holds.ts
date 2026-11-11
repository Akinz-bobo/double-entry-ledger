import type { FastifyInstance } from 'fastify';
import { captureHold, createHold, getHold, voidHold } from '../../ledger/holds.js';
import { sendIdempotent, type RouteContext } from '../context.js';
import * as schemas from '../schemas.js';
import { serializeHold, serializeTransaction } from '../serialize.js';

export function holdRoutes(app: FastifyInstance, context: RouteContext): void {
  const { pool, metrics } = context;

  app.post('/holds', async (request, reply) => {
    const body = schemas.createHoldBody.parse(request.body);
    await sendIdempotent(context, request, reply, 'POST /v1/holds', async (client) => {
      const hold = await createHold(client, body);
      return { status: 201, body: serializeHold(hold) };
    });
  });

  app.get('/holds/:id', { config: { scope: 'read' } }, async (request) => {
    const { id } = schemas.holdParams.parse(request.params);
    return serializeHold(await getHold(pool, id));
  });

  app.post('/holds/:id/capture', async (request, reply) => {
    const { id } = schemas.holdParams.parse(request.params);
    const body = schemas.captureHoldBody.parse(request.body);
    const { replayed } = await sendIdempotent(
      context,
      request,
      reply,
      `POST /v1/holds/${id}/capture`,
      async (client) => {
        const { hold, transaction } = await captureHold(client, id, body);
        return {
          status: 200,
          body: { hold: serializeHold(hold), transaction: serializeTransaction(transaction) },
        };
      },
    );
    if (!replayed) metrics.transactionsPosted.inc({ kind: 'capture' });
  });

  app.post('/holds/:id/void', async (request, reply) => {
    const { id } = schemas.holdParams.parse(request.params);
    await sendIdempotent(context, request, reply, `POST /v1/holds/${id}/void`, async (client) => {
      const hold = await voidHold(client, id);
      return { status: 200, body: serializeHold(hold) };
    });
  });
}
