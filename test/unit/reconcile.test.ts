import { describe, expect, it } from 'vitest';
import { reconcile, type StatementLine } from '../../src/reconciliation/reconcile.js';

const debit = (reference: string, amount: bigint): StatementLine => ({
  reference,
  direction: 'debit',
  amount,
});
const credit = (reference: string, amount: bigint): StatementLine => ({
  reference,
  direction: 'credit',
  amount,
});

describe('reconcile', () => {
  it('reports a clean match when both sides agree', () => {
    const lines = [debit('pay-1', 500n), credit('refund-1', 200n)];
    const report = reconcile(lines, [...lines].reverse());
    expect(report.balanced).toBe(true);
    expect(report.matched).toBe(2);
  });

  it('flags a payment the provider settled that the ledger never recorded', () => {
    const report = reconcile([debit('pay-1', 500n)], [debit('pay-1', 500n), debit('pay-2', 300n)]);
    expect(report.balanced).toBe(false);
    expect(report.missingInLedger).toEqual([{ reference: 'pay-2', amount: 300n }]);
  });

  it('flags a ledger posting the provider has no record of', () => {
    const report = reconcile([debit('pay-1', 500n), debit('pay-9', 100n)], [debit('pay-1', 500n)]);
    expect(report.missingInStatement).toEqual([{ reference: 'pay-9', amount: 100n }]);
  });

  it('flags a reference whose amounts disagree', () => {
    const report = reconcile([debit('pay-1', 500n)], [debit('pay-1', 450n)]);
    expect(report.amountMismatches).toEqual([
      { reference: 'pay-1', ledgerAmount: 500n, statementAmount: 450n },
    ]);
  });

  it('treats a debit and a credit of the same size as different', () => {
    const report = reconcile([debit('pay-1', 500n)], [credit('pay-1', 500n)]);
    expect(report.amountMismatches).toHaveLength(1);
  });

  it('nets several ledger entries under one reference', () => {
    const report = reconcile([debit('pay-1', 500n), credit('pay-1', 20n)], [debit('pay-1', 480n)]);
    expect(report.balanced).toBe(true);
  });

  it('reports a reference that appears twice on the statement', () => {
    const report = reconcile([debit('pay-1', 500n)], [debit('pay-1', 250n), debit('pay-1', 250n)]);
    expect(report.duplicateStatementReferences).toEqual(['pay-1']);
    expect(report.balanced).toBe(false);
  });

  it('is balanced when there is nothing on either side', () => {
    expect(reconcile([], []).balanced).toBe(true);
  });
});
