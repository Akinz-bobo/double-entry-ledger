import type { FastifyInstance } from 'fastify';
import { getTransaction, postTransaction, reverseTransaction } from '../../ledger/transactions.js';
import { sendIdempotent, type RouteContext } from '../context.js';
import * as schemas from '../schemas.js';
import { serializeTransaction } from '../serialize.js';

export function transactionRoutes(app: FastifyInstance, context: RouteContext): void {
  const { pool, metrics } = context;

  app.post('/transactions', async (request, reply) => {
    const body = schemas.postTransactionBody.parse(request.body);
    const { replayed } = await sendIdempotent(
      context,
      request,
      reply,
      'POST /v1/transactions',
      async (client) => {
        const transaction = await postTransaction(client, body);
        return { status: 201, body: serializeTransaction(transaction) };
      },
    );
    if (!replayed) metrics.transactionsPosted.inc({ kind: 'posting' });
  });

  app.get('/transactions/:id', { config: { scope: 'read' } }, async (request) => {
    const { id } = schemas.transactionParams.parse(request.params);
    return serializeTransaction(await getTransaction(pool, id));
  });

  app.post('/transactions/:id/reversals', async (request, reply) => {
    const { id } = schemas.transactionParams.parse(request.params);
    const body = schemas.reverseTransactionBody.parse(request.body ?? {});
    const { replayed } = await sendIdempotent(
      context,
      request,
      reply,
      `POST /v1/transactions/${id}/reversals`,
      async (client) => {
        const reversal = await reverseTransaction(client, id, body);
        return { status: 201, body: serializeTransaction(reversal) };
      },
    );
    if (!replayed) metrics.transactionsPosted.inc({ kind: 'reversal' });
  });
}
