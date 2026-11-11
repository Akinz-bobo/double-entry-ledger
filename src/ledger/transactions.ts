import type pg from 'pg';
import { pgErrorCode, type Client, type Pool } from '../db/pool.js';
import { errors } from '../domain/errors.js';
import { lockAccounts } from './accounts.js';
import { recordEvent } from './events.js';
import { planPosting, type EntryInput } from './posting.js';
import type { Direction, Entry, Transaction } from './types.js';

type Queryable = Pick<pg.ClientBase, 'query'> | Pool;

const UNIQUE_VIOLATION = '23505';
const REVERSES_UNIQUE_CONSTRAINT = 'transactions_reverses_key';

export interface PostTransactionInput {
  reference: string;
  description?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  entries: EntryInput[];
}

interface TransactionRow {
  id: string;
  reference: string;
  description: string | null;
  metadata: Record<string, unknown>;
  reverses: string | null;
  posted_at: Date;
}

/**
 * Posts a balanced transaction. Must run inside a database transaction: the
 * account rows stay locked from the balance check to the totals update, so two
 * concurrent postings can never both spend the same funds.
 */
export async function postTransaction(
  client: Client,
  input: PostTransactionInput,
  { reverses }: { reverses?: string } = {},
): Promise<Transaction> {
  const accounts = await lockAccounts(
    client,
    input.entries.map((entry) => entry.accountCode),
  );
  const deltas = planPosting(input.entries, accounts);

  let row: TransactionRow;
  try {
    // A savepoint keeps the outer transaction usable if the reference is taken.
    await client.query('SAVEPOINT insert_transaction');
    const inserted = await client.query<TransactionRow>(
      `INSERT INTO transactions (reference, description, metadata, reverses)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.reference, input.description ?? null, input.metadata ?? {}, reverses ?? null],
    );
    row = inserted.rows[0] as TransactionRow;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT insert_transaction');
    if (pgErrorCode(error) === UNIQUE_VIOLATION) {
      const constraint = (error as { constraint?: string }).constraint;
      throw reverses && constraint === REVERSES_UNIQUE_CONSTRAINT
        ? errors.alreadyReversed(reverses)
        : errors.duplicateReference(input.reference);
    }
    throw error;
  }

  const lines = input.entries.map((entry) => {
    // planPosting has already proved every account exists.
    const account = accounts.get(entry.accountCode);
    if (!account) throw errors.accountNotFound([entry.accountCode]);
    return { ...entry, accountId: account.id, currency: account.currency };
  });

  const insertedEntries = await client.query<{ id: bigint }>(
    `INSERT INTO entries (transaction_id, account_id, direction, amount, currency)
     SELECT $1, account_id, direction, amount, currency
     FROM unnest($2::uuid[], $3::entry_direction[], $4::bigint[], $5::char(3)[])
       WITH ORDINALITY AS line (account_id, direction, amount, currency, position)
     ORDER BY position
     RETURNING id`,
    [
      row.id,
      lines.map((line) => line.accountId),
      lines.map((line) => line.direction),
      lines.map((line) => line.amount.toString()),
      lines.map((line) => line.currency),
    ],
  );

  await client.query(
    `UPDATE accounts a
     SET debits_posted = a.debits_posted + d.debits,
         credits_posted = a.credits_posted + d.credits
     FROM unnest($1::uuid[], $2::bigint[], $3::bigint[]) AS d (id, debits, credits)
     WHERE a.id = d.id`,
    [
      deltas.map((delta) => delta.account.id),
      deltas.map((delta) => delta.debits.toString()),
      deltas.map((delta) => delta.credits.toString()),
    ],
  );

  await recordEvent(client, reverses ? 'transaction.reversed' : 'transaction.posted', {
    id: row.id,
    reference: row.reference,
    ...(reverses ? { reverses } : {}),
  });

  const entries: Entry[] = lines.map((line, index) => ({
    id: (insertedEntries.rows[index] as { id: bigint }).id,
    accountCode: line.accountCode,
    direction: line.direction,
    amount: line.amount,
    currency: line.currency,
  }));
  return toTransaction(row, entries);
}

/**
 * Undoes a transaction by posting its mirror image: every debit becomes a
 * credit and every credit a debit. The original is left untouched.
 */
export async function reverseTransaction(
  client: Client,
  transactionId: string,
  { reference, description }: { reference?: string | undefined; description?: string | undefined },
): Promise<Transaction> {
  const original = await getTransaction(client, transactionId);
  if (original.reverses) throw errors.cannotReverseReversal(transactionId);

  // Check up front so the caller hears "already reversed" and not whichever
  // balance rule the second attempt happens to trip. Two reversals racing past
  // this check are still stopped by the unique constraint on `reverses`.
  const existing = await client.query('SELECT 1 FROM transactions WHERE reverses = $1', [
    transactionId,
  ]);
  if (existing.rowCount) throw errors.alreadyReversed(transactionId);

  return postTransaction(
    client,
    {
      reference: reference ?? `reversal:${original.reference}`,
      description: description ?? `Reversal of ${original.reference}`,
      metadata: { reversalOf: original.id },
      entries: original.entries.map((entry) => ({
        accountCode: entry.accountCode,
        direction: entry.direction === 'debit' ? 'credit' : 'debit',
        amount: entry.amount,
      })),
    },
    { reverses: original.id },
  );
}

export async function getTransaction(db: Queryable, id: string): Promise<Transaction> {
  const found = await db.query<TransactionRow>('SELECT * FROM transactions WHERE id = $1', [id]);
  const row = found.rows[0];
  if (!row) throw errors.transactionNotFound(id);

  const entries = await db.query<{
    id: bigint;
    code: string;
    direction: Direction;
    amount: bigint;
    currency: string;
  }>(
    `SELECT e.id, a.code, e.direction, e.amount, e.currency
     FROM entries e
     JOIN accounts a ON a.id = e.account_id
     WHERE e.transaction_id = $1
     ORDER BY e.id`,
    [id],
  );
  return toTransaction(
    row,
    entries.rows.map((entry) => ({
      id: entry.id,
      accountCode: entry.code,
      direction: entry.direction,
      amount: entry.amount,
      currency: entry.currency,
    })),
  );
}

function toTransaction(row: TransactionRow, entries: Entry[]): Transaction {
  return {
    id: row.id,
    reference: row.reference,
    description: row.description,
    metadata: row.metadata,
    reverses: row.reverses,
    postedAt: row.posted_at,
    entries,
  };
}
