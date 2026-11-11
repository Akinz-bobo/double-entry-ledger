import type { FastifyInstance } from 'fastify';
import {
  createAccount,
  getAccount,
  listAccountEntries,
  listAccounts,
} from '../../ledger/accounts.js';
import type { RouteContext } from '../context.js';
import * as schemas from '../schemas.js';
import { serializeAccount, serializeAccountEntry } from '../serialize.js';

export function accountRoutes(app: FastifyInstance, { pool }: RouteContext): void {
  app.post('/accounts', async (request, reply) => {
    const body = schemas.createAccountBody.parse(request.body);
    const account = await createAccount(pool, body);
    return reply.status(201).send(serializeAccount(account));
  });

  app.get('/accounts', { config: { scope: 'read' } }, async (request) => {
    const query = schemas.listAccountsQuery.parse(request.query);
    const page = await listAccounts(pool, query);
    return { accounts: page.accounts.map(serializeAccount), nextCursor: page.nextCursor };
  });

  app.get('/accounts/:code', { config: { scope: 'read' } }, async (request) => {
    const { code } = schemas.accountParams.parse(request.params);
    return serializeAccount(await getAccount(pool, code));
  });

  app.get('/accounts/:code/entries', { config: { scope: 'read' } }, async (request) => {
    const { code } = schemas.accountParams.parse(request.params);
    const query = schemas.entriesQuery.parse(request.query);
    const page = await listAccountEntries(pool, code, query);
    return {
      entries: page.entries.map(serializeAccountEntry),
      nextCursor: page.nextCursor?.toString() ?? null,
    };
  });
}
