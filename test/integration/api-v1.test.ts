import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders,
  createTestApp,
  createTestPool,
  idempotencyKey,
  readOnlyHeaders,
  resetDatabase,
} from './helpers.js';

const pool = createTestPool();
let app: FastifyInstance;

const post = (url: string, payload: unknown, headers: Record<string, string> = authHeaders) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...headers, 'idempotency-key': idempotencyKey() },
    payload: payload as object,
  });

const get = (url: string, headers: Record<string, string> = authHeaders) =>
  app.inject({ url, headers });

beforeAll(async () => {
  app = await createTestApp(pool);
});
beforeEach(async () => {
  await resetDatabase(pool);
  const account = (code: string, type: string, currency = 'USD') =>
    post('/v1/accounts', { code, name: code, type, currency });
  await account('bank:cash', 'asset');
  await account('wallet:alice', 'liability');
  await account('merchant:shop', 'liability');
  await account('bank:cash-ngn', 'asset', 'NGN');
  await post('/v1/transactions', {
    reference: 'deposit-1',
    entries: [
      { accountCode: 'bank:cash', direction: 'debit', amount: '1000' },
      { accountCode: 'wallet:alice', direction: 'credit', amount: '1000' },
    ],
  });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('API key scopes', () => {
  it('lets a read-only key read', async () => {
    expect((await get('/v1/accounts/wallet:alice', readOnlyHeaders)).statusCode).toBe(200);
    expect((await get('/v1/reports/trial-balance', readOnlyHeaders)).statusCode).toBe(200);
  });

  it('stops a read-only key from writing', async () => {
    const response = await post(
      '/v1/accounts',
      { code: 'wallet:bob', name: 'Bob', type: 'liability', currency: 'USD' },
      readOnlyHeaders,
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect((await get('/v1/accounts/wallet:bob')).statusCode).toBe(404);
  });

  it('lets a read-only key run a reconciliation, which changes nothing', async () => {
    const response = await post(
      '/v1/reconciliations',
      {
        accountCode: 'bank:cash',
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
        statement: [{ reference: 'deposit-1', direction: 'debit', amount: '1000' }],
      },
      readOnlyHeaders,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ balanced: true });
  });
});

describe('request ids', () => {
  it('returns a generated request id', async () => {
    const response = await get('/healthz', {});
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a well-formed inbound request id', async () => {
    const response = await get('/healthz', { 'x-request-id': 'trace-abc.123' });
    expect(response.headers['x-request-id']).toBe('trace-abc.123');
  });

  it('replaces a malformed inbound request id', async () => {
    const response = await get('/healthz', { 'x-request-id': 'bad id\twith spaces' });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('listing accounts', () => {
  it('pages through accounts in code order', async () => {
    const first = (await get('/v1/accounts?limit=3')).json<{
      accounts: { code: string }[];
      nextCursor: string | null;
    }>();
    expect(first.accounts.map((account) => account.code)).toEqual([
      'bank:cash',
      'bank:cash-ngn',
      'merchant:shop',
    ]);

    const second = (await get(`/v1/accounts?limit=3&after=${first.nextCursor}`)).json<{
      accounts: { code: string }[];
      nextCursor: string | null;
    }>();
    expect(second.accounts.map((account) => account.code)).toEqual(['wallet:alice']);
    expect(second.nextCursor).toBeNull();
  });

  it('filters by type and currency', async () => {
    const byType = (await get('/v1/accounts?type=liability')).json<{ accounts: unknown[] }>();
    expect(byType.accounts).toHaveLength(2);

    const byCurrency = (await get('/v1/accounts?currency=NGN')).json<{
      accounts: { code: string }[];
    }>();
    expect(byCurrency.accounts.map((account) => account.code)).toEqual(['bank:cash-ngn']);
  });
});

describe('holds', () => {
  const createHold = (amount: string, reference = 'auth-1') =>
    post('/v1/holds', { accountCode: 'wallet:alice', amount, reference });

  it('creates a hold and shows it in the available balance', async () => {
    const created = await createHold('300');
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: 'pending', amount: '300' });

    expect((await get('/v1/accounts/wallet:alice')).json()).toMatchObject({
      balance: '1000',
      availableBalance: '700',
      held: '300',
    });
  });

  it('captures a hold', async () => {
    const { id } = (await createHold('300')).json<{ id: string }>();
    const captured = await post(`/v1/holds/${id}/capture`, {
      destinationAccountCode: 'merchant:shop',
      amount: '250',
    });

    expect(captured.statusCode).toBe(200);
    expect(captured.json()).toMatchObject({
      hold: { status: 'captured', capturedAmount: '250' },
      transaction: { reference: 'capture:auth-1' },
    });
    expect((await get('/v1/accounts/merchant:shop')).json()).toMatchObject({ balance: '250' });
    expect((await get('/v1/accounts/wallet:alice')).json()).toMatchObject({
      balance: '750',
      availableBalance: '750',
    });
  });

  it('voids a hold and answers 409 when it is voided again', async () => {
    const { id } = (await createHold('300')).json<{ id: string }>();

    expect((await post(`/v1/holds/${id}/void`, {})).json()).toMatchObject({ status: 'voided' });
    const again = await post(`/v1/holds/${id}/void`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'hold_not_pending' } });
    expect((await get(`/v1/holds/${id}`)).json()).toMatchObject({ status: 'voided' });
  });

  it('answers 422 when the account cannot cover the hold', async () => {
    const response = await createHold('1001');
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'insufficient_funds' } });
  });

  it('rejects an expiry in the past', async () => {
    const response = await post('/v1/holds', {
      accountCode: 'wallet:alice',
      amount: '100',
      reference: 'auth-1',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('trial balance', () => {
  it('reports matching debits and credits for each currency', async () => {
    const response = await get('/v1/reports/trial-balance');
    expect(response.json()).toEqual({
      balanced: true,
      currencies: [
        { currency: 'NGN', debits: '0', credits: '0', balanced: true },
        { currency: 'USD', debits: '1000', credits: '1000', balanced: true },
      ],
    });
  });
});

describe('events', () => {
  it('serves the event feed with a cursor', async () => {
    const first = (await get('/v1/events?limit=4')).json<{
      events: { type: string }[];
      nextCursor: string;
    }>();
    expect(first.events.map((event) => event.type)).toEqual([
      'account.created',
      'account.created',
      'account.created',
      'account.created',
    ]);

    const second = (await get(`/v1/events?cursor=${first.nextCursor}`)).json<{
      events: { type: string; payload: { reference: string } }[];
    }>();
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({
      type: 'transaction.posted',
      payload: { reference: 'deposit-1' },
    });
  });

  it('answers 400 for a cursor it did not issue', async () => {
    const response = await get('/v1/events?cursor=not-a-cursor');
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_cursor' } });
  });
});
