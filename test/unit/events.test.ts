import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../src/ledger/events.js';

describe('event cursors', () => {
  it('round-trips a cursor', () => {
    const cursor = { txid: '4815162342', id: '99' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('produces a URL-safe string', () => {
    expect(encodeCursor({ txid: '123456789', id: '987654321' })).toMatch(/^[\w-]+$/);
  });

  it.each(['', 'not-a-cursor', Buffer.from('12:').toString('base64url'), 'MTI6YWJj'])(
    'rejects %j',
    (value) => {
      expect(decodeCursor(value)).toBeNull();
    },
  );
});
