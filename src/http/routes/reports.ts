import type { FastifyInstance } from 'fastify';
import { errors } from '../../domain/errors.js';
import { decodeCursor, listEvents } from '../../ledger/events.js';
import { reconcileAccount } from '../../reconciliation/reconcile.js';
import { trialBalance } from '../../reports/trial-balance.js';
import type { RouteContext } from '../context.js';
import * as schemas from '../schemas.js';
import { serializeEvent, serializeReport, serializeTrialBalance } from '../serialize.js';

export function reportRoutes(app: FastifyInstance, { pool }: RouteContext): void {
  // A POST because the statement travels in the body, but it changes nothing.
  app.post('/reconciliations', { config: { scope: 'read' } }, async (request) => {
    const body = schemas.reconcileBody.parse(request.body);
    return serializeReport(await reconcileAccount(pool, body));
  });

  app.get('/reports/trial-balance', { config: { scope: 'read' } }, async () => {
    return serializeTrialBalance(await trialBalance(pool));
  });

  app.get('/events', { config: { scope: 'read' } }, async (request) => {
    const query = schemas.eventsQuery.parse(request.query);
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (cursor === null) throw errors.invalidCursor();

    const page = await listEvents(pool, { cursor, limit: query.limit });
    return { events: page.events.map(serializeEvent), nextCursor: page.nextCursor };
  });
}
