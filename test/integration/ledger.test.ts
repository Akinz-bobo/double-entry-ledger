import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/pool.js';
import { DomainError } from '../../src/domain/errors.js';
import { createAccount, getAccount, listAccountEntries } from '../../src/ledger/accounts.js';
import { fingerprint, runIdempotent } from '../../src/ledger/idempotency.js';
import {
  getTransaction,
  postTransaction,
  reverseTransaction,
  type PostTransactionInput,
} from '../../src/ledger/transactions.js';
import { balanceOf } from '../../src/ledger/types.js';
import { createTestPool, resetDatabase } from './helpers.js';

const pool = createTestPool();

const post = (input: PostTransactionInput) =>
  withTransaction(pool, (client) => postTransaction(client, input));

const balance = async (code: string) => balanceOf(await getAccount(pool, code));

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error('expected the promise to reject');
}

/** A funded customer wallet backed by cash held at the bank. */
async function seed(funds = 10_000n) {
  await createAccount(pool, {
    code: 'bank:cash',
    name: 'Cash at bank',
    type: 'asset',
    currency: 'USD',
    allowNegative: false,
  });
  await createAccount(pool, {
    code: 'wallet:alice',
    name: 'Alice',
    type: 'liability',
    currency: 'USD',
    allowNegative: false,
  });
  await createAccount(pool, {
    code: 'wallet:bob',
    name: 'Bob',
    type: 'liability',
    currency: 'USD',
    allowNegative: false,
  });
  if (funds > 0n) {
    await post({
      reference: 'deposit-1',
      entries: [
        { accountCode: 'bank:cash', direction: 'debit', amount: funds },
        { accountCode: 'wallet:alice', direction: 'credit', amount: funds },
      ],
    });
  }
}

const transfer = (reference: string, from: string, to: string, amount: bigint) =>
  post({
    reference,
    entries: [
      { accountCode: from, direction: 'debit', amount },
      { accountCode: to, direction: 'credit', amount },
    ],
  });

beforeEach(() => resetDatabase(pool));
afterAll(() => pool.end());

describe('posting', () => {
  it('moves money between accounts and keeps the books balanced', async () => {
    await seed();
    await transfer('transfer-1', 'wallet:alice', 'wallet:bob', 2_500n);

    expect(await balance('wallet:alice')).toBe(7_500n);
    expect(await balance('wallet:bob')).toBe(2_500n);
    expect(await balance('bank:cash')).toBe(10_000n);
  });

  it('stores the entries in the order they were given', async () => {
    await seed();
    const posted = await transfer('transfer-1', 'wallet:alice', 'wallet:bob', 100n);
    const loaded = await getTransaction(pool, posted.id);

    expect(
      loaded.entries.map((entry) => [entry.accountCode, entry.direction, entry.amount]),
    ).toEqual([
      ['wallet:alice', 'debit', 100n],
      ['wallet:bob', 'credit', 100n],
    ]);
    expect(posted.entries).toEqual(loaded.entries);
  });

  it('rejects a second transaction with the same reference', async () => {
    await seed();
    await transfer('transfer-1', 'wallet:alice', 'wallet:bob', 100n);

    expect(await rejectionCode(transfer('transfer-1', 'wallet:alice', 'wallet:bob', 100n))).toBe(
      'duplicate_reference',
    );
    expect(await balance('wallet:bob')).toBe(100n);
  });

  it('refuses to overdraw an account and leaves balances untouched', async () => {
    await seed(1_000n);

    expect(await rejectionCode(transfer('too-much', 'wallet:alice', 'wallet:bob', 1_001n))).toBe(
      'insufficient_funds',
    );
    expect(await balance('wallet:alice')).toBe(1_000n);
    expect(await balance('wallet:bob')).toBe(0n);
  });

  it('rejects an unknown account', async () => {
    await seed();
    expect(await rejectionCode(transfer('t', 'wallet:alice', 'wallet:nobody', 1n))).toBe(
      'account_not_found',
    );
  });
});

describe('concurrency', () => {
  it('never loses an update when many transfers hit the same accounts at once', async () => {
    await seed(10_000n);

    // 40 transfers each way, all racing over the same two rows.
    await transfer('prime-bob', 'wallet:alice', 'wallet:bob', 5_000n);
    const transfers = Array.from({ length: 40 }, (_, index) => [
      transfer(`a-to-b-${index}`, 'wallet:alice', 'wallet:bob', 7n),
      transfer(`b-to-a-${index}`, 'wallet:bob', 'wallet:alice', 3n),
    ]).flat();
    await Promise.all(transfers);

    expect(await balance('wallet:alice')).toBe(5_000n - 40n * 7n + 40n * 3n);
    expect(await balance('wallet:bob')).toBe(5_000n + 40n * 7n - 40n * 3n);
    expect((await balance('wallet:alice')) + (await balance('wallet:bob'))).toBe(10_000n);
  });

  it('lets exactly as many concurrent withdrawals succeed as the balance allows', async () => {
    await seed(1_000n);

    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        transfer(`spend-${index}`, 'wallet:alice', 'wallet:bob', 100n),
      ),
    );

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(10);
    expect(await balance('wallet:alice')).toBe(0n);
    expect(await balance('wallet:bob')).toBe(1_000n);
  });
});

describe('reversal', () => {
  it('undoes a transaction with a mirror-image posting', async () => {
    await seed();
    const original = await transfer('transfer-1', 'wallet:alice', 'wallet:bob', 2_500n);

    const reversal = await withTransaction(pool, (client) =>
      reverseTransaction(client, original.id, {}),
    );

    expect(reversal.reverses).toBe(original.id);
    expect(reversal.reference).toBe('reversal:transfer-1');
    expect(await balance('wallet:alice')).toBe(10_000n);
    expect(await balance('wallet:bob')).toBe(0n);
  });

  it('refuses to reverse the same transaction twice', async () => {
    await seed();
    const original = await transfer('transfer-1', 'wallet:alice', 'wallet:bob', 100n);
    const reverse = (reference?: string) =>
      withTransaction(pool, (client) => reverseTransaction(client, original.id, { reference }));

    await reverse();
    expect(await rejectionCode(reverse('second-attempt'))).toBe('already_reversed');
    expect(await balance('wallet:bob')).toBe(0n);
  });

  it('refuses to reverse a reversal', async () => {
    await seed();
    const original = await transfer('transfer-1', 'wallet:alice', 'wallet:bob', 100n);
    const reversal = await withTransaction(pool, (client) =>
      reverseTransaction(client, original.id, {}),
    );

    const attempt = withTransaction(pool, (client) => reverseTransaction(client, reversal.id, {}));
    expect(await rejectionCode(attempt)).toBe('cannot_reverse_reversal');
  });

  it('refuses a reversal the receiving account can no longer cover', async () => {
    await seed(1_000n);
    const original = await transfer('transfer-1', 'wallet:alice', 'wallet:bob', 1_000n);
    await createAccount(pool, {
      code: 'wallet:carol',
      name: 'Carol',
      type: 'liability',
      currency: 'USD',
      allowNegative: false,
    });
    await transfer('transfer-2', 'wallet:bob', 'wallet:carol', 600n);

    const attempt = withTransaction(pool, (client) => reverseTransaction(client, original.id, {}));
    expect(await rejectionCode(attempt)).toBe('insufficient_funds');
  });
});

describe('database invariants', () => {
  it('blocks edits and deletes on posted entries', async () => {
    await seed();
    await expect(pool.query('UPDATE entries SET amount = amount + 1')).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query('DELETE FROM entries')).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM transactions')).rejects.toThrow(/append-only/);
  });

  it('rejects an unbalanced transaction written straight to the tables', async () => {
    await seed();
    const account = await getAccount(pool, 'wallet:alice');

    const attempt = withTransaction(pool, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO transactions (reference) VALUES ('manual') RETURNING id`,
      );
      await client.query(
        `INSERT INTO entries (transaction_id, account_id, direction, amount, currency)
         VALUES ($1, $2, 'debit', 100, 'USD')`,
        [inserted.rows[0]?.id, account.id],
      );
    });

    await expect(attempt).rejects.toThrow(/not balanced/);
  });

  it('rejects an overdraft written straight to the accounts table', async () => {
    await seed(100n);
    await expect(
      pool.query(`UPDATE accounts SET debits_posted = 500 WHERE code = 'wallet:alice'`),
    ).rejects.toThrow(/accounts_no_overdraft/);
  });
});

describe('account history', () => {
  it('pages through entries newest first', async () => {
    await seed();
    for (let index = 1; index <= 5; index++) {
      await transfer(`transfer-${index}`, 'wallet:alice', 'wallet:bob', BigInt(index));
    }

    const first = await listAccountEntries(pool, 'wallet:bob', { limit: 2 });
    expect(first.entries.map((entry) => entry.reference)).toEqual(['transfer-5', 'transfer-4']);
    expect(first.nextCursor).not.toBeNull();

    const second = await listAccountEntries(pool, 'wallet:bob', {
      limit: 2,
      before: first.nextCursor ?? undefined,
    });
    expect(second.entries.map((entry) => entry.reference)).toEqual(['transfer-3', 'transfer-2']);

    const last = await listAccountEntries(pool, 'wallet:bob', {
      limit: 2,
      before: second.nextCursor ?? undefined,
    });
    expect(last.entries.map((entry) => entry.reference)).toEqual(['transfer-1']);
    expect(last.nextCursor).toBeNull();
  });
});

describe('idempotency', () => {
  const body = { reference: 'transfer-1' };
  const run = (key: string, requestBody: unknown = body) =>
    runIdempotent(pool, key, fingerprint(requestBody), async (client) => {
      const posted = await postTransaction(client, {
        reference: 'transfer-1',
        entries: [
          { accountCode: 'wallet:alice', direction: 'debit', amount: 100n },
          { accountCode: 'wallet:bob', direction: 'credit', amount: 100n },
        ],
      });
      return { status: 201, body: { id: posted.id } };
    });

  it('runs the work once and replays the stored response after that', async () => {
    await seed();
    const first = await run('key-12345');
    const second = await run('key-12345');

    expect(first.replayed).toBe(false);
    expect(second).toEqual({ ...first, replayed: true });
    expect(await balance('wallet:bob')).toBe(100n);
  });

  it('runs the work once when the same key arrives many times at once', async () => {
    await seed();
    const results = await Promise.all(Array.from({ length: 10 }, () => run('key-12345')));

    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(results.map((result) => JSON.stringify(result.body))).size).toBe(1);
    expect(await balance('wallet:bob')).toBe(100n);
  });

  it('rejects a key reused with a different request', async () => {
    await seed();
    await run('key-12345');
    expect(await rejectionCode(run('key-12345', { reference: 'something-else' }))).toBe(
      'idempotency_key_reused',
    );
  });

  it('frees the key when the work fails, so the client can retry', async () => {
    await seed(50n);
    expect(await rejectionCode(run('key-12345'))).toBe('insufficient_funds');

    await post({
      reference: 'deposit-2',
      entries: [
        { accountCode: 'bank:cash', direction: 'debit', amount: 100n },
        { accountCode: 'wallet:alice', direction: 'credit', amount: 100n },
      ],
    });
    const retry = await run('key-12345');
    expect(retry.replayed).toBe(false);
    expect(retry.status).toBe(201);
  });
});
