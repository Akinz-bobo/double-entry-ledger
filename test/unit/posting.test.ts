import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.js';
import { planPosting } from '../../src/ledger/posting.js';
import { balanceOf, normalSide, type Account, type AccountType } from '../../src/ledger/types.js';

function account(code: string, type: AccountType, overrides: Partial<Account> = {}): Account {
  return {
    id: `id-${code}`,
    code,
    name: code,
    type,
    currency: 'USD',
    allowNegative: false,
    debitsPosted: 0n,
    creditsPosted: 0n,
    createdAt: new Date(0),
    ...overrides,
  };
}

function accountsOf(...list: Account[]): Map<string, Account> {
  return new Map(list.map((item) => [item.code, item]));
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
}

describe('normalSide and balanceOf', () => {
  it('treats assets and expenses as debit-normal, the rest as credit-normal', () => {
    expect(normalSide('asset')).toBe('debit');
    expect(normalSide('expense')).toBe('debit');
    expect(normalSide('liability')).toBe('credit');
    expect(normalSide('equity')).toBe('credit');
    expect(normalSide('revenue')).toBe('credit');
  });

  it('reports a positive balance on the normal side', () => {
    expect(balanceOf({ type: 'asset', debitsPosted: 500n, creditsPosted: 200n })).toBe(300n);
    expect(balanceOf({ type: 'liability', debitsPosted: 200n, creditsPosted: 500n })).toBe(300n);
  });
});

describe('planPosting', () => {
  const cash = account('cash', 'asset', { debitsPosted: 1000n });
  const wallet = account('wallet', 'liability');

  it('returns the change for each account in a balanced transaction', () => {
    const deltas = planPosting(
      [
        { accountCode: 'cash', direction: 'debit', amount: 250n },
        { accountCode: 'wallet', direction: 'credit', amount: 250n },
      ],
      accountsOf(cash, wallet),
    );
    expect(deltas).toEqual([
      { account: cash, debits: 250n, credits: 0n },
      { account: wallet, debits: 0n, credits: 250n },
    ]);
  });

  it('adds up several entries on the same account', () => {
    const fees = account('fees', 'revenue');
    const deltas = planPosting(
      [
        { accountCode: 'cash', direction: 'debit', amount: 100n },
        { accountCode: 'wallet', direction: 'credit', amount: 90n },
        { accountCode: 'fees', direction: 'credit', amount: 10n },
        { accountCode: 'cash', direction: 'debit', amount: 5n },
        { accountCode: 'fees', direction: 'credit', amount: 5n },
      ],
      accountsOf(cash, wallet, fees),
    );
    expect(deltas.find((delta) => delta.account.code === 'cash')?.debits).toBe(105n);
    expect(deltas.find((delta) => delta.account.code === 'fees')?.credits).toBe(15n);
  });

  it('rejects a transaction with fewer than two entries', () => {
    const run = () =>
      planPosting([{ accountCode: 'cash', direction: 'debit', amount: 1n }], accountsOf(cash));
    expect(codeOf(run)).toBe('too_few_entries');
  });

  it('rejects debits that do not equal credits', () => {
    const run = () =>
      planPosting(
        [
          { accountCode: 'cash', direction: 'debit', amount: 100n },
          { accountCode: 'wallet', direction: 'credit', amount: 99n },
        ],
        accountsOf(cash, wallet),
      );
    expect(codeOf(run)).toBe('unbalanced_transaction');
  });

  it('requires each currency to balance on its own', () => {
    const eurCash = account('cash-eur', 'asset', { currency: 'EUR', allowNegative: true });
    const run = () =>
      planPosting(
        [
          { accountCode: 'cash', direction: 'debit', amount: 100n },
          { accountCode: 'cash-eur', direction: 'credit', amount: 100n },
        ],
        accountsOf(cash, eurCash),
      );
    expect(codeOf(run)).toBe('unbalanced_transaction');
  });

  it('rejects an entry for an account that was not loaded', () => {
    const run = () =>
      planPosting(
        [
          { accountCode: 'cash', direction: 'debit', amount: 1n },
          { accountCode: 'ghost', direction: 'credit', amount: 1n },
        ],
        accountsOf(cash),
      );
    expect(codeOf(run)).toBe('account_not_found');
  });

  it('refuses to take an account below zero', () => {
    const run = () =>
      planPosting(
        [
          { accountCode: 'cash', direction: 'credit', amount: 1001n },
          { accountCode: 'wallet', direction: 'debit', amount: 1001n },
        ],
        accountsOf(cash, account('wallet', 'liability', { creditsPosted: 5000n })),
      );
    expect(codeOf(run)).toBe('insufficient_funds');
  });

  it('allows spending an account down to exactly zero', () => {
    const run = () =>
      planPosting(
        [
          { accountCode: 'cash', direction: 'credit', amount: 1000n },
          { accountCode: 'wallet', direction: 'debit', amount: 1000n },
        ],
        accountsOf(cash, account('wallet', 'liability', { creditsPosted: 1000n })),
      );
    expect(codeOf(run)).toBeUndefined();
  });

  it('lets an account that allows it go negative', () => {
    const overdraft = account('overdraft', 'asset', { allowNegative: true });
    const run = () =>
      planPosting(
        [
          { accountCode: 'overdraft', direction: 'credit', amount: 50n },
          { accountCode: 'wallet', direction: 'debit', amount: 50n },
        ],
        accountsOf(overdraft, account('wallet', 'liability', { creditsPosted: 50n })),
      );
    expect(codeOf(run)).toBeUndefined();
  });
});
