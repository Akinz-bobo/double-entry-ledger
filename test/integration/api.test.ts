import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders,
  createTestApp,
  createTestPool,
  idempotencyKey,
  resetDatabase,
} from './helpers.js';

const pool = createTestPool();
let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp(pool);
});
beforeEach(() => resetDatabase(pool));
afterAll(async () => {
  await app.close();
  await pool.end();
});

const createAccount = (code: string, type: string, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/accounts',
    headers: authHeaders,
    payload: { code, name: code, type, currency: 'USD', ...extra },
  });

const postTransaction = (payload: unknown, key = idempotencyKey()) =>
  app.inject({
    method: 'POST',
    url: '/v1/transactions',
    headers: { ...authHeaders, 'idempotency-key': key },
    payload: payload as object,
  });

const transferPayload = (reference: string, amount: string) => ({
  reference,
  entries: [
    { accountCode: 'bank:cash', direction: 'debit', amount },
    { accountCode: 'wallet:alice', direction: 'credit', amount },
  ],
});

async function seedAccounts() {
  await createAccount('bank:cash', 'asset');
  await createAccount('wallet:alice', 'liability');
}

const balanceOf = async (code: string) => {
  const response = await app.inject({ url: `/v1/accounts/${code}`, headers: authHeaders });
  return response.json<{ balance: string }>().balance;
};

describe('authentication', () => {
  it('rejects a request with no API key', async () => {
    const response = await app.inject({ url: '/v1/accounts/bank:cash' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('rejects a wrong API key', async () => {
    const response = await app.inject({
      url: '/v1/accounts/bank:cash',
      headers: { 'x-api-key': 'not-the-key' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('leaves health checks open', async () => {
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/readyz' })).json()).toEqual({ status: 'ready' });
  });
});

describe('accounts', () => {
  it('creates an account and reads it back with a zero balance', async () => {
    const created = await createAccount('wallet:alice', 'liability');
    expect(created.statusCode).toBe(201);

    const fetched = await app.inject({ url: '/v1/accounts/wallet:alice', headers: authHeaders });
    expect(fetched.json()).toMatchObject({
      code: 'wallet:alice',
      type: 'liability',
      currency: 'USD',
      balance: '0',
    });
  });

  it('answers 409 for a code that is taken', async () => {
    await createAccount('wallet:alice', 'liability');
    const duplicate = await createAccount('wallet:alice', 'liability');
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: 'account_exists' } });
  });

  it('answers 400 with the failing fields for an invalid body', async () => {
    const response = await createAccount('Wallet Alice', 'savings', { currency: 'usd' });
    expect(response.statusCode).toBe(400);
    const paths = response
      .json<{ error: { details: { issues: { path: string }[] } } }>()
      .error.details.issues.map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(['code', 'type', 'currency']));
  });

  it('answers 404 for an unknown account', async () => {
    const response = await app.inject({ url: '/v1/accounts/nope', headers: authHeaders });
    expect(response.statusCode).toBe(404);
  });
});

describe('transactions', () => {
  beforeEach(seedAccounts);

  it('posts a transaction and updates balances', async () => {
    const response = await postTransaction(transferPayload('deposit-1', '5000'));

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      reference: 'deposit-1',
      entries: [
        { accountCode: 'bank:cash', direction: 'debit', amount: '5000' },
        { accountCode: 'wallet:alice', direction: 'credit', amount: '5000' },
      ],
    });
    expect(await balanceOf('wallet:alice')).toBe('5000');
  });

  it('requires an Idempotency-Key header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: authHeaders,
      payload: transferPayload('deposit-1', '5000'),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'idempotency_key_required' } });
  });

  it('replays the first response when a request is retried with the same key', async () => {
    const key = idempotencyKey();
    const first = await postTransaction(transferPayload('deposit-1', '5000'), key);
    const retry = await postTransaction(transferPayload('deposit-1', '5000'), key);

    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(first.json());
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(await balanceOf('wallet:alice')).toBe('5000');
  });

  it('answers 422 when a key is reused for a different request', async () => {
    const key = idempotencyKey();
    await postTransaction(transferPayload('deposit-1', '5000'), key);
    const reused = await postTransaction(transferPayload('deposit-2', '9999'), key);

    expect(reused.statusCode).toBe(422);
    expect(reused.json()).toMatchObject({ error: { code: 'idempotency_key_reused' } });
  });

  it('answers 422 for an unbalanced transaction', async () => {
    const response = await postTransaction({
      reference: 'bad',
      entries: [
        { accountCode: 'bank:cash', direction: 'debit', amount: '100' },
        { accountCode: 'wallet:alice', direction: 'credit', amount: '90' },
      ],
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'unbalanced_transaction' } });
  });

  it('rejects fractional and negative amounts', async () => {
    for (const amount of ['10.5', '-10', '0']) {
      const response = await postTransaction(transferPayload('bad', amount));
      expect(response.statusCode).toBe(400);
    }
  });

  it('reverses a transaction', async () => {
    const posted = await postTransaction(transferPayload('deposit-1', '5000'));
    const { id } = posted.json<{ id: string }>();

    const reversal = await app.inject({
      method: 'POST',
      url: `/v1/transactions/${id}/reversals`,
      headers: { ...authHeaders, 'idempotency-key': idempotencyKey() },
      payload: {},
    });

    expect(reversal.statusCode).toBe(201);
    expect(reversal.json()).toMatchObject({ reverses: id, reference: 'reversal:deposit-1' });
    expect(await balanceOf('wallet:alice')).toBe('0');
  });

  it('lists an account’s entries', async () => {
    await postTransaction(transferPayload('deposit-1', '5000'));
    await postTransaction(transferPayload('deposit-2', '250'));

    const response = await app.inject({
      url: '/v1/accounts/wallet:alice/entries?limit=1',
      headers: authHeaders,
    });
    const page = response.json<{ entries: { reference: string }[]; nextCursor: string | null }>();
    expect(page.entries.map((entry) => entry.reference)).toEqual(['deposit-2']);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe('reconciliation', () => {
  beforeEach(seedAccounts);

  it('compares the ledger with a provider statement', async () => {
    await postTransaction(transferPayload('pay-1', '5000'));
    await postTransaction(transferPayload('pay-2', '700'));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/reconciliations',
      headers: authHeaders,
      payload: {
        accountCode: 'bank:cash',
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
        statement: [
          { reference: 'pay-1', direction: 'debit', amount: '5000' },
          { reference: 'pay-2', direction: 'debit', amount: '650' },
          { reference: 'pay-3', direction: 'debit', amount: '100' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      balanced: false,
      matched: 1,
      amountMismatches: [{ reference: 'pay-2', ledgerAmount: '700', statementAmount: '650' }],
      missingInLedger: [{ reference: 'pay-3', amount: '100' }],
      missingInStatement: [],
      duplicateStatementReferences: [],
    });
  });
});

describe('metrics', () => {
  it('exposes Prometheus metrics, including posted transactions', async () => {
    await seedAccounts();
    await postTransaction(transferPayload('deposit-1', '5000'));

    const response = await app.inject({ url: '/metrics' });
    expect(response.statusCode).toBe(200);
    // The counter is shared by every test in this file, so only its presence is checked.
    expect(response.body).toMatch(/ledger_transactions_posted_total\{kind="posting"\} [1-9]/);
    expect(response.body).toContain('http_request_duration_seconds_bucket');
  });
});
