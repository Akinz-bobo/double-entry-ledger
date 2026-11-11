import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/pool.js';
import { DomainError } from '../../src/domain/errors.js';
import { createAccount, getAccount } from '../../src/ledger/accounts.js';
import { captureHold, createHold, expireHolds, getHold, voidHold } from '../../src/ledger/holds.js';
import { postTransaction } from '../../src/ledger/transactions.js';
import { availableBalanceOf, balanceOf } from '../../src/ledger/types.js';
import { createTestPool, resetDatabase } from './helpers.js';

const pool = createTestPool();

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error('expected the promise to reject');
}

const hold = (reference: string, amount: bigint, expiresAt?: Date) =>
  withTransaction(pool, (client) =>
    createHold(client, { accountCode: 'wallet:alice', amount, reference, expiresAt }),
  );

const capture = (id: string, amount?: bigint) =>
  withTransaction(pool, (client) =>
    captureHold(client, id, { destinationAccountCode: 'merchant:shop', amount }),
  );

const balances = async (code: string) => {
  const account = await getAccount(pool, code);
  return {
    balance: balanceOf(account),
    available: availableBalanceOf(account),
    held: account.held,
  };
};

beforeEach(async () => {
  await resetDatabase(pool);
  const base = { currency: 'USD', allowNegative: false } as const;
  await createAccount(pool, { ...base, code: 'bank:cash', name: 'Cash', type: 'asset' });
  await createAccount(pool, { ...base, code: 'wallet:alice', name: 'Alice', type: 'liability' });
  await createAccount(pool, { ...base, code: 'merchant:shop', name: 'Shop', type: 'liability' });
  await withTransaction(pool, (client) =>
    postTransaction(client, {
      reference: 'deposit-1',
      entries: [
        { accountCode: 'bank:cash', direction: 'debit', amount: 1_000n },
        { accountCode: 'wallet:alice', direction: 'credit', amount: 1_000n },
      ],
    }),
  );
});
afterAll(() => pool.end());

describe('creating a hold', () => {
  it('reserves funds without moving them', async () => {
    const created = await hold('auth-1', 300n);

    expect(created).toMatchObject({ status: 'pending', amount: 300n, accountCode: 'wallet:alice' });
    expect(await balances('wallet:alice')).toEqual({
      balance: 1_000n,
      available: 700n,
      held: 300n,
    });
  });

  it('refuses a hold larger than the available balance', async () => {
    await hold('auth-1', 800n);
    expect(await rejectionCode(hold('auth-2', 201n))).toBe('insufficient_funds');
  });

  it('stops held funds from being spent by an ordinary posting', async () => {
    await hold('auth-1', 800n);

    const spend = withTransaction(pool, (client) =>
      postTransaction(client, {
        reference: 'spend-1',
        entries: [
          { accountCode: 'wallet:alice', direction: 'debit', amount: 201n },
          { accountCode: 'merchant:shop', direction: 'credit', amount: 201n },
        ],
      }),
    );
    expect(await rejectionCode(spend)).toBe('insufficient_funds');
  });

  it('never reserves more than the balance when holds race', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) => hold(`auth-${index}`, 100n)),
    );

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(10);
    expect(await balances('wallet:alice')).toEqual({
      balance: 1_000n,
      available: 0n,
      held: 1_000n,
    });
  });

  it('rejects a reused reference', async () => {
    await hold('auth-1', 100n);
    expect(await rejectionCode(hold('auth-1', 100n))).toBe('duplicate_reference');
    expect((await balances('wallet:alice')).held).toBe(100n);
  });
});

describe('capturing a hold', () => {
  it('moves the money and releases the reservation', async () => {
    const created = await hold('auth-1', 300n);
    const { hold: captured, transaction } = await capture(created.id);

    expect(captured).toMatchObject({
      status: 'captured',
      capturedAmount: 300n,
      transactionId: transaction.id,
    });
    expect(transaction.reference).toBe('capture:auth-1');
    expect(await balances('wallet:alice')).toEqual({ balance: 700n, available: 700n, held: 0n });
    expect((await balances('merchant:shop')).balance).toBe(300n);
  });

  it('captures part of a hold and returns the rest', async () => {
    const created = await hold('auth-1', 300n);
    await capture(created.id, 120n);

    expect(await balances('wallet:alice')).toEqual({ balance: 880n, available: 880n, held: 0n });
    expect((await balances('merchant:shop')).balance).toBe(120n);
  });

  it('refuses to capture more than was held', async () => {
    const created = await hold('auth-1', 300n);
    expect(await rejectionCode(capture(created.id, 301n))).toBe('capture_exceeds_hold');
    expect((await balances('wallet:alice')).held).toBe(300n);
  });

  it('lets only one of several racing captures win', async () => {
    const created = await hold('auth-1', 300n);
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => capture(created.id)));

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect((await balances('merchant:shop')).balance).toBe(300n);
    expect(await balances('wallet:alice')).toEqual({ balance: 700n, available: 700n, held: 0n });
  });

  it('refuses to capture a hold that was voided', async () => {
    const created = await hold('auth-1', 300n);
    await withTransaction(pool, (client) => voidHold(client, created.id));
    expect(await rejectionCode(capture(created.id))).toBe('hold_not_pending');
  });
});

describe('voiding a hold', () => {
  it('returns the funds to the available balance', async () => {
    const created = await hold('auth-1', 300n);
    const voided = await withTransaction(pool, (client) => voidHold(client, created.id));

    expect(voided.status).toBe('voided');
    expect(voided.resolvedAt).not.toBeNull();
    expect(await balances('wallet:alice')).toEqual({
      balance: 1_000n,
      available: 1_000n,
      held: 0n,
    });
  });

  it('refuses to void twice', async () => {
    const created = await hold('auth-1', 300n);
    const attempt = () => withTransaction(pool, (client) => voidHold(client, created.id));
    await attempt();
    expect(await rejectionCode(attempt())).toBe('hold_not_pending');
  });
});

describe('expiry', () => {
  /** Creates a hold, then moves its deadline into the past. */
  async function expiredHold(reference: string, amount: bigint) {
    const created = await hold(reference, amount, new Date(Date.now() + 60_000));
    await pool.query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      created.id,
    ]);
    return created;
  }

  it('refuses to capture a hold past its deadline', async () => {
    const created = await expiredHold('auth-1', 300n);
    expect(await rejectionCode(capture(created.id))).toBe('hold_expired');
  });

  it('releases expired holds and leaves live ones alone', async () => {
    const expired = await expiredHold('auth-1', 300n);
    const live = await hold('auth-2', 200n, new Date(Date.now() + 60_000));
    const open = await hold('auth-3', 100n);

    expect(await expireHolds(pool)).toBe(1);

    expect((await getHold(pool, expired.id)).status).toBe('expired');
    expect((await getHold(pool, live.id)).status).toBe('pending');
    expect((await getHold(pool, open.id)).status).toBe('pending');
    expect(await balances('wallet:alice')).toEqual({
      balance: 1_000n,
      available: 700n,
      held: 300n,
    });
  });

  it('expires each hold once when sweeps run at the same time', async () => {
    for (let index = 0; index < 5; index++) await expiredHold(`auth-${index}`, 100n);

    const counts = await Promise.all([expireHolds(pool), expireHolds(pool), expireHolds(pool)]);

    expect(counts.reduce((total, count) => total + count, 0)).toBe(5);
    expect(await balances('wallet:alice')).toEqual({
      balance: 1_000n,
      available: 1_000n,
      held: 0n,
    });
  });
});

describe('database invariants', () => {
  it('rejects held funds that exceed the balance', async () => {
    await expect(
      pool.query(`UPDATE accounts SET held = 1001 WHERE code = 'wallet:alice'`),
    ).rejects.toThrow(/accounts_no_overdraft/);
  });

  it('rejects a captured hold with no transaction', async () => {
    const created = await hold('auth-1', 300n);
    await expect(
      pool.query(`UPDATE holds SET status = 'captured', resolved_at = now() WHERE id = $1`, [
        created.id,
      ]),
    ).rejects.toThrow(/holds_capture_is_complete/);
  });
});
