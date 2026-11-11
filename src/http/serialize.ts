import type { AccountEntry } from '../ledger/accounts.js';
import { balanceOf, type Account, type Transaction } from '../ledger/types.js';
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
