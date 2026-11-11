export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type Direction = 'debit' | 'credit';

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  currency: string;
  allowNegative: boolean;
  debitsPosted: bigint;
  creditsPosted: bigint;
  createdAt: Date;
}

export interface Entry {
  id: bigint;
  accountCode: string;
  direction: Direction;
  amount: bigint;
  currency: string;
}

export interface Transaction {
  id: string;
  reference: string;
  description: string | null;
  metadata: Record<string, unknown>;
  reverses: string | null;
  postedAt: Date;
  entries: Entry[];
}

/** The side on which an account's balance grows. */
export function normalSide(type: AccountType): Direction {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

/** An account's balance, positive when it sits on its normal side. */
export function balanceOf(
  account: Pick<Account, 'type' | 'debitsPosted' | 'creditsPosted'>,
): bigint {
  return normalSide(account.type) === 'debit'
    ? account.debitsPosted - account.creditsPosted
    : account.creditsPosted - account.debitsPosted;
}
