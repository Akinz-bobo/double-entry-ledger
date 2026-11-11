import { describe, expect, it } from 'vitest';
import { fingerprint } from '../../src/ledger/idempotency.js';

describe('fingerprint', () => {
  it('ignores the order of object keys', () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('respects the order of array items', () => {
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
  });

  it('changes when any value changes', () => {
    expect(fingerprint({ amount: '100' })).not.toBe(fingerprint({ amount: '101' }));
  });

  it('tells a string from a number', () => {
    expect(fingerprint({ amount: '100' })).not.toBe(fingerprint({ amount: 100 }));
  });
});
