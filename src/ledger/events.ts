import type pg from 'pg';
import type { Pool } from '../db/pool.js';

export type EventType =
  | 'account.created'
  | 'transaction.posted'
  | 'transaction.reversed'
  | 'hold.created'
  | 'hold.captured'
  | 'hold.voided'
  | 'hold.expired';

export interface LedgerEvent {
  id: bigint;
  type: EventType;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Appends an event. Call it with the same client as the change it describes:
 * the event then commits if and only if the change does, so consumers never
 * see an event for something that was rolled back, or miss one that was not.
 */
export async function recordEvent(
  client: Pick<pg.ClientBase, 'query'>,
  type: EventType,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query('INSERT INTO ledger_events (type, payload) VALUES ($1, $2)', [type, payload]);
}

interface Cursor {
  txid: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.txid}:${cursor.id}`).toString('base64url');
}

export function decodeCursor(value: string): Cursor | null {
  const match = /^(\d+):(\d+)$/.exec(Buffer.from(value, 'base64url').toString());
  return match?.[1] && match[2] ? { txid: match[1], id: match[2] } : null;
}

/**
 * Reads the feed in a stable order, resuming after `cursor`.
 *
 * Ordering by id alone would be unsafe: ids are handed out when a row is
 * inserted, not when it commits, so a slow transaction can commit an event
 * with a lower id than one a reader has already passed, and that event would
 * be skipped forever. Instead the feed is ordered by (transaction id, id) and
 * only shows events from transactions older than every transaction still in
 * flight. Anything a reader has seen can no longer be overtaken.
 */
export async function listEvents(
  pool: Pool,
  { cursor, limit }: { cursor?: Cursor | undefined; limit: number },
): Promise<{ events: LedgerEvent[]; nextCursor: string | null }> {
  const result = await pool.query<{
    id: bigint;
    txid: string;
    type: EventType;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id, txid::text AS txid, type, payload, created_at
     FROM ledger_events
     WHERE txid < pg_snapshot_xmin(pg_current_snapshot())
       AND ($1::xid8 IS NULL OR txid > $1::xid8 OR (txid = $1::xid8 AND id > $2::bigint))
     ORDER BY txid, id
     LIMIT $3`,
    [cursor?.txid ?? null, cursor?.id ?? null, limit],
  );
  const last = result.rows.at(-1);
  return {
    events: result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: row.payload,
      createdAt: row.created_at,
    })),
    // Always hand back a cursor, so a consumer that reached the end can poll from there.
    nextCursor: last
      ? encodeCursor({ txid: last.txid, id: last.id.toString() })
      : cursor
        ? encodeCursor(cursor)
        : null,
  };
}
