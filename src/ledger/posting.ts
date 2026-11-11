import { errors } from '../domain/errors.js';
import { availableBalanceOf, type Account, type Direction } from './types.js';

export interface EntryInput {
  accountCode: string;
  direction: Direction;
  amount: bigint;
}

export interface AccountDelta {
  account: Account;
  debits: bigint;
  credits: bigint;
}

/**
 * Checks a proposed set of entries against the accounts they touch and returns
 * the change to apply to each account. Pure: no I/O, so every ledger rule can
 * be tested without a database.
 *
 * Rules enforced:
 *  - at least two entries
 *  - debits equal credits, separately for each currency
 *  - no account's available balance (balance less holds) ends below zero,
 *    unless the account allows it
 */
export function planPosting(entries: EntryInput[], accounts: Map<string, Account>): AccountDelta[] {
  if (entries.length < 2) throw errors.tooFewEntries();

  const deltas = new Map<string, AccountDelta>();
  const totals = new Map<string, { debits: bigint; credits: bigint }>();

  for (const entry of entries) {
    const account = accounts.get(entry.accountCode);
    if (!account) throw errors.accountNotFound([entry.accountCode]);

    const delta = deltas.get(account.code) ?? { account, debits: 0n, credits: 0n };
    const total = totals.get(account.currency) ?? { debits: 0n, credits: 0n };
    if (entry.direction === 'debit') {
      delta.debits += entry.amount;
      total.debits += entry.amount;
    } else {
      delta.credits += entry.amount;
      total.credits += entry.amount;
    }
    deltas.set(account.code, delta);
    totals.set(account.currency, total);
  }

  for (const [currency, total] of totals) {
    if (total.debits !== total.credits) {
      throw errors.unbalanced(currency, total.debits, total.credits);
    }
  }

  for (const { account, debits, credits } of deltas.values()) {
    if (account.allowNegative) continue;
    const after = availableBalanceOf({
      type: account.type,
      debitsPosted: account.debitsPosted + debits,
      creditsPosted: account.creditsPosted + credits,
      held: account.held,
    });
    if (after < 0n) throw errors.insufficientFunds(account.code);
  }

  return [...deltas.values()];
}
