import type pg from 'pg';
import { pgErrorCode, type Pool } from '../db/pool.js';
import { errors } from '../domain/errors.js';
import type { Account, AccountType, Direction } from './types.js';

type Queryable = Pick<pg.ClientBase, 'query'> | Pool;

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  currency: string;
  allow_negative: boolean;
  debits_posted: bigint;
  credits_posted: bigint;
  held: bigint;
  created_at: Date;
}

const UNIQUE_VIOLATION = '23505';

export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    currency: row.currency,
    allowNegative: row.allow_negative,
    debitsPosted: row.debits_posted,
    creditsPosted: row.credits_posted,
    held: row.held,
    createdAt: row.created_at,
  };
}

export interface CreateAccountInput {
  code: string;
  name: string;
  type: AccountType;
  currency: string;
  allowNegative: boolean;
}

export async function createAccount(db: Queryable, input: CreateAccountInput): Promise<Account> {
  try {
    const result = await db.query<AccountRow>(
      // One statement, so the account and its event are written atomically.
      `WITH created AS (
         INSERT INTO accounts (code, name, type, currency, allow_negative)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *
       ), event AS (
         INSERT INTO ledger_events (type, payload)
         SELECT 'account.created', jsonb_build_object('id', id, 'code', code) FROM created
       )
       SELECT * FROM created`,
      [input.code, input.name, input.type, input.currency, input.allowNegative],
    );
    return toAccount(result.rows[0] as AccountRow);
  } catch (error) {
    if (pgErrorCode(error) === UNIQUE_VIOLATION) throw errors.accountExists(input.code);
    throw error;
  }
}

export async function getAccount(db: Queryable, code: string): Promise<Account> {
  const result = await db.query<AccountRow>('SELECT * FROM accounts WHERE code = $1', [code]);
  const row = result.rows[0];
  if (!row) throw errors.accountNotFound([code]);
  return toAccount(row);
}

/**
 * Loads accounts and locks their rows until the surrounding transaction ends.
 * Rows are always locked in id order: two postings that touch the same pair of
 * accounts then queue up behind each other and cannot deadlock.
 */
export async function lockAccounts(
  client: Pick<pg.ClientBase, 'query'>,
  codes: string[],
): Promise<Map<string, Account>> {
  const unique = [...new Set(codes)];
  const result = await client.query<AccountRow>(
    'SELECT * FROM accounts WHERE code = ANY($1) ORDER BY id FOR UPDATE',
    [unique],
  );
  const accounts = new Map(result.rows.map((row) => [row.code, toAccount(row)]));
  const missing = unique.filter((code) => !accounts.has(code));
  if (missing.length > 0) throw errors.accountNotFound(missing);
  return accounts;
}

export interface AccountEntry {
  id: bigint;
  transactionId: string;
  reference: string;
  direction: Direction;
  amount: bigint;
  postedAt: Date;
}

/** One page of an account's history, newest first, using keyset pagination. */
export async function listAccountEntries(
  db: Queryable,
  code: string,
  { limit, before }: { limit: number; before?: bigint | undefined },
): Promise<{ entries: AccountEntry[]; nextCursor: bigint | null }> {
  const account = await getAccount(db, code);
  const result = await db.query<{
    id: bigint;
    transaction_id: string;
    reference: string;
    direction: Direction;
    amount: bigint;
    posted_at: Date;
  }>(
    `SELECT e.id, e.transaction_id, t.reference, e.direction, e.amount, t.posted_at
     FROM entries e
     JOIN transactions t ON t.id = e.transaction_id
     WHERE e.account_id = $1 AND ($2::bigint IS NULL OR e.id < $2)
     ORDER BY e.id DESC
     LIMIT $3`,
    [account.id, before ?? null, limit + 1],
  );
  const page = result.rows.slice(0, limit);
  const last = page.at(-1);
  return {
    entries: page.map((row) => ({
      id: row.id,
      transactionId: row.transaction_id,
      reference: row.reference,
      direction: row.direction,
      amount: row.amount,
      postedAt: row.posted_at,
    })),
    nextCursor: result.rows.length > limit && last ? last.id : null,
  };
}

export interface ListAccountsInput {
  limit: number;
  /** Return accounts whose code sorts after this one. */
  after?: string | undefined;
  type?: AccountType | undefined;
  currency?: string | undefined;
}

/** One page of accounts in code order, using keyset pagination. */
export async function listAccounts(
  db: Queryable,
  { limit, after, type, currency }: ListAccountsInput,
): Promise<{ accounts: Account[]; nextCursor: string | null }> {
  const result = await db.query<AccountRow>(
    `SELECT * FROM accounts
     WHERE ($1::text IS NULL OR code > $1)
       AND ($2::account_type IS NULL OR type = $2)
       AND ($3::text IS NULL OR currency = $3)
     ORDER BY code
     LIMIT $4`,
    [after ?? null, type ?? null, currency ?? null, limit + 1],
  );
  const page = result.rows.slice(0, limit).map(toAccount);
  const last = page.at(-1);
  return { accounts: page, nextCursor: result.rows.length > limit && last ? last.code : null };
}
