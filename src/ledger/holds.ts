import type pg from 'pg';
import { pgErrorCode, withTransaction, type Client, type Pool } from '../db/pool.js';
import { errors } from '../domain/errors.js';
import { lockAccounts } from './accounts.js';
import { recordEvent } from './events.js';
import { postTransaction } from './transactions.js';
import { availableBalanceOf, normalSide, type Transaction } from './types.js';

type Queryable = Pick<pg.ClientBase, 'query'> | Pool;

export type HoldStatus = 'pending' | 'captured' | 'voided' | 'expired';

export interface Hold {
  id: string;
  reference: string;
  accountCode: string;
  amount: bigint;
  status: HoldStatus;
  expiresAt: Date | null;
  capturedAmount: bigint | null;
  transactionId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

interface HoldRow {
  id: string;
  reference: string;
  account_id: string;
  account_code: string;
  amount: bigint;
  status: HoldStatus;
  expires_at: Date | null;
  captured_amount: bigint | null;
  transaction_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

const UNIQUE_VIOLATION = '23505';

const SELECT_HOLD = `
  SELECT h.*, a.code AS account_code
  FROM holds h
  JOIN accounts a ON a.id = h.account_id`;

function toHold(row: HoldRow): Hold {
  return {
    id: row.id,
    reference: row.reference,
    accountCode: row.account_code,
    amount: row.amount,
    status: row.status,
    expiresAt: row.expires_at,
    capturedAmount: row.captured_amount,
    transactionId: row.transaction_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export async function getHold(db: Queryable, id: string): Promise<Hold> {
  const result = await db.query<HoldRow>(`${SELECT_HOLD} WHERE h.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw errors.holdNotFound(id);
  return toHold(row);
}

/**
 * Reserves funds on an account without moving them. The amount stops counting
 * towards the available balance until the hold is captured, voided or expires.
 * This is the "authorize" half of authorize-and-capture.
 */
export async function createHold(
  client: Client,
  input: { accountCode: string; amount: bigint; reference: string; expiresAt?: Date | undefined },
): Promise<Hold> {
  const accounts = await lockAccounts(client, [input.accountCode]);
  const account = accounts.get(input.accountCode);
  if (!account) throw errors.accountNotFound([input.accountCode]);
  if (!account.allowNegative && availableBalanceOf(account) < input.amount) {
    throw errors.insufficientFunds(account.code);
  }

  let id: string;
  try {
    await client.query('SAVEPOINT insert_hold');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO holds (reference, account_id, amount, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [input.reference, account.id, input.amount.toString(), input.expiresAt ?? null],
    );
    id = (inserted.rows[0] as { id: string }).id;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT insert_hold');
    if (pgErrorCode(error) === UNIQUE_VIOLATION) throw errors.duplicateReference(input.reference);
    throw error;
  }

  await client.query('UPDATE accounts SET held = held + $2 WHERE id = $1', [
    account.id,
    input.amount.toString(),
  ]);
  await recordEvent(client, 'hold.created', { id, reference: input.reference });
  return getHold(client, id);
}

/** Loads a hold, locks its row, and checks that it can still be resolved. */
async function lockPendingHold(client: Client, id: string): Promise<HoldRow> {
  const result = await client.query<HoldRow & { is_expired: boolean }>(
    `SELECT h.*, a.code AS account_code,
            (h.expires_at IS NOT NULL AND h.expires_at <= now()) AS is_expired
     FROM holds h
     JOIN accounts a ON a.id = h.account_id
     WHERE h.id = $1
     FOR UPDATE OF h`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw errors.holdNotFound(id);
  if (row.status !== 'pending') throw errors.holdNotPending(id, row.status);
  if (row.is_expired) throw errors.holdExpired(id);
  return row;
}

/**
 * Turns a hold into a real movement of money: releases the reservation and
 * posts a transaction from the held account to `destinationAccountCode`.
 * Capturing less than the held amount releases the rest back to the account.
 */
export async function captureHold(
  client: Client,
  id: string,
  input: {
    destinationAccountCode: string;
    amount?: bigint | undefined;
    reference?: string | undefined;
    description?: string | undefined;
  },
): Promise<{ hold: Hold; transaction: Transaction }> {
  const hold = await lockPendingHold(client, id);
  const amount = input.amount ?? hold.amount;
  if (amount > hold.amount) throw errors.captureExceedsHold(id);

  // Lock both accounts in the usual order before touching either.
  const accounts = await lockAccounts(client, [hold.account_code, input.destinationAccountCode]);
  const source = accounts.get(hold.account_code);
  if (!source) throw errors.accountNotFound([hold.account_code]);

  // Release the whole reservation first, so the posting below can spend it.
  await client.query('UPDATE accounts SET held = held - $2 WHERE id = $1', [
    hold.account_id,
    hold.amount.toString(),
  ]);

  const increases = normalSide(source.type);
  const transaction = await postTransaction(client, {
    reference: input.reference ?? `capture:${hold.reference}`,
    description: input.description ?? `Capture of hold ${hold.reference}`,
    metadata: { holdId: hold.id },
    entries: [
      {
        accountCode: hold.account_code,
        direction: increases === 'debit' ? 'credit' : 'debit',
        amount,
      },
      { accountCode: input.destinationAccountCode, direction: increases, amount },
    ],
  });

  await client.query(
    `UPDATE holds
     SET status = 'captured', captured_amount = $2, transaction_id = $3, resolved_at = now()
     WHERE id = $1`,
    [id, amount.toString(), transaction.id],
  );
  await recordEvent(client, 'hold.captured', {
    id,
    reference: hold.reference,
    transactionId: transaction.id,
  });
  return { hold: await getHold(client, id), transaction };
}

/** Cancels a hold and returns its funds to the available balance. */
export async function voidHold(client: Client, id: string): Promise<Hold> {
  const hold = await lockPendingHold(client, id);
  await release(client, [hold], 'voided');
  await recordEvent(client, 'hold.voided', { id, reference: hold.reference });
  return getHold(client, id);
}

async function release(
  client: Client,
  holds: HoldRow[],
  status: 'voided' | 'expired',
): Promise<void> {
  await lockAccounts(
    client,
    holds.map((hold) => hold.account_code),
  );
  for (const hold of holds) {
    await client.query('UPDATE accounts SET held = held - $2 WHERE id = $1', [
      hold.account_id,
      hold.amount.toString(),
    ]);
  }
  await client.query('UPDATE holds SET status = $2, resolved_at = now() WHERE id = ANY($1)', [
    holds.map((hold) => hold.id),
    status,
  ]);
}

/**
 * Releases pending holds whose deadline has passed. Safe to run from several
 * instances at once: each sweep skips rows another sweep has already locked.
 * Returns how many holds were expired.
 */
export async function expireHolds(pool: Pool, batchSize = 100): Promise<number> {
  return withTransaction(pool, async (client) => {
    const due = await client.query<HoldRow>(
      `SELECT h.*, a.code AS account_code
       FROM holds h
       JOIN accounts a ON a.id = h.account_id
       WHERE h.status = 'pending' AND h.expires_at IS NOT NULL AND h.expires_at <= now()
       ORDER BY h.expires_at
       LIMIT $1
       FOR UPDATE OF h SKIP LOCKED`,
      [batchSize],
    );
    if (due.rows.length === 0) return 0;

    await release(client, due.rows, 'expired');
    for (const hold of due.rows) {
      await recordEvent(client, 'hold.expired', { id: hold.id, reference: hold.reference });
    }
    return due.rows.length;
  });
}
