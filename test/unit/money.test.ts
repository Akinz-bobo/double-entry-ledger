import { describe, expect, it } from 'vitest';
import { MAX_AMOUNT, amountSchema, currencySchema } from '../../src/domain/money.js';

describe('amountSchema', () => {
  it('parses a string of digits into a bigint', () => {
    expect(amountSchema.parse('1500')).toBe(1500n);
  });

  it('parses a JSON integer', () => {
    expect(amountSchema.parse(1500)).toBe(1500n);
  });

  it('keeps precision beyond what a JSON number can hold', () => {
    expect(amountSchema.parse('9007199254740993')).toBe(9007199254740993n);
  });

  it.each(['0', '-5', '1.5', '01', 'abc', '', ' 5'])('rejects %j', (value) => {
    expect(amountSchema.safeParse(value).success).toBe(false);
  });

  it.each([0, -1, 1.5])('rejects the number %d', (value) => {
    expect(amountSchema.safeParse(value).success).toBe(false);
  });

  it('rejects an amount above the maximum', () => {
    expect(amountSchema.safeParse(MAX_AMOUNT.toString()).success).toBe(true);
    expect(amountSchema.safeParse((MAX_AMOUNT + 1n).toString()).success).toBe(false);
  });
});

describe('currencySchema', () => {
  it('accepts a three-letter uppercase code', () => {
    expect(currencySchema.safeParse('NGN').success).toBe(true);
  });

  it.each(['usd', 'US', 'USDT', ''])('rejects %j', (value) => {
    expect(currencySchema.safeParse(value).success).toBe(false);
  });
});
