import type { AccountEntry } from '../ledger/accounts.js';
import type { LedgerEvent } from '../ledger/events.js';
import type { Hold } from '../ledger/holds.js';
import { availableBalanceOf, balanceOf, type Account, type Transaction } from '../ledger/types.js';
import type { TrialBalanceLine } from '../reports/trial-balance.js';
import type { ReconciliationReport } from '../reconciliation/reconcile.js';

// Amounts leave the API as strings: JSON numbers cannot hold a 64-bit integer.

export function serializeAccount(account: Account) {
  return {
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    currency: account.currency,
    allowNegative: account.allowNegative,
    balance: balanceOf(account).toString(),
    availableBalance: availableBalanceOf(account).toString(),
    held: account.held.toString(),
    debitsPosted: account.debitsPosted.toString(),
    creditsPosted: account.creditsPosted.toString(),
    createdAt: account.createdAt.toISOString(),
  };
}

export function serializeTransaction(transaction: Transaction) {
  return {
    id: transaction.id,
    reference: transaction.reference,
    description: transaction.description,
    metadata: transaction.metadata,
    reverses: transaction.reverses,
    postedAt: transaction.postedAt.toISOString(),
    entries: transaction.entries.map((entry) => ({
      id: entry.id.toString(),
      accountCode: entry.accountCode,
      direction: entry.direction,
      amount: entry.amount.toString(),
      currency: entry.currency,
    })),
  };
}

export function serializeAccountEntry(entry: AccountEntry) {
  return {
    id: entry.id.toString(),
    transactionId: entry.transactionId,
    reference: entry.reference,
    direction: entry.direction,
    amount: entry.amount.toString(),
    postedAt: entry.postedAt.toISOString(),
  };
}

export function serializeReport(report: ReconciliationReport) {
  const line = (item: { reference: string; amount: bigint }) => ({
    reference: item.reference,
    amount: item.amount.toString(),
  });
  return {
    balanced: report.balanced,
    matched: report.matched,
    amountMismatches: report.amountMismatches.map((mismatch) => ({
      reference: mismatch.reference,
      ledgerAmount: mismatch.ledgerAmount.toString(),
      statementAmount: mismatch.statementAmount.toString(),
    })),
    missingInLedger: report.missingInLedger.map(line),
    missingInStatement: report.missingInStatement.map(line),
    duplicateStatementReferences: report.duplicateStatementReferences,
  };
}

export function serializeHold(hold: Hold) {
  return {
    id: hold.id,
    reference: hold.reference,
    accountCode: hold.accountCode,
    amount: hold.amount.toString(),
    status: hold.status,
    expiresAt: hold.expiresAt?.toISOString() ?? null,
    capturedAmount: hold.capturedAmount?.toString() ?? null,
    transactionId: hold.transactionId,
    createdAt: hold.createdAt.toISOString(),
    resolvedAt: hold.resolvedAt?.toISOString() ?? null,
  };
}

export function serializeEvent(event: LedgerEvent) {
  return {
    id: event.id.toString(),
    type: event.type,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}

export function serializeTrialBalance(lines: TrialBalanceLine[]) {
  return {
    balanced: lines.every((line) => line.balanced),
    currencies: lines.map((line) => ({
      currency: line.currency,
      debits: line.debits.toString(),
      credits: line.credits.toString(),
      balanced: line.balanced,
    })),
  };
}
