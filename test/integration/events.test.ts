import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { decodeCursor, listEvents } from '../../src/ledger/events.js';
import { createHold, voidHold } from '../../src/ledger/holds.js';
import { postTransaction, reverseTransaction } from '../../src/ledger/transactions.js';
import { createTestPool, resetDatabase } from './helpers.js';

const pool = createTestPool();

const deposit = (reference: string, amount = 100n) =>
  withTransaction(pool, (client) =>
    postTransaction(client, {
      reference,
      entries: [
        { accountCode: 'bank:cash', direction: 'debit', amount },
        { accountCode: 'wallet:alice', direction: 'credit', amount },
      ],
    }),
  );

const readAll = async () => (await listEvents(pool, { limit: 500 })).events;

beforeEach(async () => {
  await resetDatabase(pool);
  const base = { currency: 'USD', allowNegative: false } as const;
  await createAccount(pool, { ...base, code: 'bank:cash', name: 'Cash', type: 'asset' });
  await createAccount(pool, { ...base, code: 'wallet:alice', name: 'Alice', type: 'liability' });
});
afterAll(() => pool.end());

describe('event feed', () => {
  it('records an event for each change, in the order they happened', async () => {
    const posted = await deposit('deposit-1');
    await withTransaction(pool, (client) => reverseTransaction(client, posted.id, {}));
    await deposit('deposit-2');
    const hold = await withTransaction(pool, (client) =>
      createHold(client, { accountCode: 'wallet:alice', amount: 50n, reference: 'auth-1' }),
    );
    await withTransaction(pool, (client) => voidHold(client, hold.id));

    const events = await readAll();
    expect(events.map((event) => event.type)).toEqual([
      'account.created',
      'account.created',
      'transaction.posted',
      'transaction.reversed',
      'transaction.posted',
      'hold.created',
      'hold.voided',
    ]);
    expect(events[2]?.payload).toEqual({ id: posted.id, reference: 'deposit-1' });
    expect(events[3]?.payload).toMatchObject({ reverses: posted.id });
  });

  it('writes no event when the change is rolled back', async () => {
    const before = (await readAll()).length;

    const failing = withTransaction(pool, async (client) => {
      await postTransaction(client, {
        reference: 'doomed',
        entries: [
          { accountCode: 'bank:cash', direction: 'debit', amount: 100n },
          { accountCode: 'wallet:alice', direction: 'credit', amount: 100n },
        ],
      });
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');

    expect(await readAll()).toHaveLength(before);
  });

  it('pages through the feed with a cursor and lets a caught-up reader keep polling', async () => {
    for (let index = 1; index <= 5; index++) await deposit(`deposit-${index}`);

    const first = await listEvents(pool, { limit: 4 });
    expect(first.events).toHaveLength(4);

    const cursor = decodeCursor(first.nextCursor ?? '') ?? undefined;
    const second = await listEvents(pool, { cursor, limit: 4 });
    expect(second.events.map((event) => event.payload.reference)).toEqual([
      'deposit-3',
      'deposit-4',
      'deposit-5',
    ]);

    // At the end of the feed the cursor stays put, and new events appear after it.
    const end = decodeCursor(second.nextCursor ?? '') ?? undefined;
    const idle = await listEvents(pool, { cursor: end, limit: 4 });
    expect(idle.events).toEqual([]);
    expect(idle.nextCursor).toBe(second.nextCursor);

    await deposit('deposit-6');
    const resumed = await listEvents(pool, { cursor: end, limit: 4 });
    expect(resumed.events.map((event) => event.payload.reference)).toEqual(['deposit-6']);
  });

  it('holds back events that an unfinished older transaction could still precede', async () => {
    const before = (await readAll()).length;

    // An older transaction writes an event and stays open...
    const slow = await pool.connect();
    try {
      await slow.query('BEGIN');
      await slow.query(
        `INSERT INTO ledger_events (type, payload) VALUES ('account.created', '{"slow": true}')`,
      );

      // ...while a newer one commits. A reader must not see the newer event
      // yet, or it would move its cursor past the slow one and miss it.
      await deposit('fast');
      expect(await readAll()).toHaveLength(before);

      await slow.query('COMMIT');
    } finally {
      slow.release();
    }

    const events = await readAll();
    expect(events.slice(before).map((event) => event.payload)).toEqual([
      { slow: true },
      expect.objectContaining({ reference: 'fast' }),
    ]);
  });

  it('is append-only', async () => {
    await expect(pool.query('DELETE FROM ledger_events')).rejects.toThrow(/append-only/);
  });
});
