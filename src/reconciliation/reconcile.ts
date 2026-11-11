import type { Pool } from '../db/pool.js';
import { getAccount } from '../ledger/accounts.js';
import type { Direction } from '../ledger/types.js';

export interface StatementLine {
  reference: string;
  direction: Direction;
  amount: bigint;
}

export interface Mismatch {
  reference: string;
  /** Net movement the ledger recorded: positive for a debit, negative for a credit. */
  ledgerAmount: bigint;
  statementAmount: bigint;
}

export interface ReconciliationReport {
  matched: number;
  amountMismatches: Mismatch[];
  /** On the external statement but never posted to the ledger. */
  missingInLedger: { reference: string; amount: bigint }[];
  /** Posted to the ledger but absent from the external statement. */
  missingInStatement: { reference: string; amount: bigint }[];
  duplicateStatementReferences: string[];
  balanced: boolean;
}

const signed = (line: { direction: Direction; amount: bigint }) =>
  line.direction === 'debit' ? line.amount : -line.amount;

/**
 * Compares what the ledger recorded for an account against an external
 * statement (a bank or payment provider export), matching on reference.
 * Pure: takes both sides as data and returns the differences.
 */
export function reconcile(
  ledger: StatementLine[],
  statement: StatementLine[],
): ReconciliationReport {
  const ledgerByReference = netByReference(ledger);
  const statementByReference = netByReference(statement);

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const line of statement) {
    if (seen.has(line.reference)) duplicates.add(line.reference);
    seen.add(line.reference);
  }

  const report: ReconciliationReport = {
    matched: 0,
    amountMismatches: [],
    missingInLedger: [],
    missingInStatement: [],
    duplicateStatementReferences: [...duplicates].sort(),
    balanced: false,
  };

  for (const [reference, statementAmount] of statementByReference) {
    const ledgerAmount = ledgerByReference.get(reference);
    if (ledgerAmount === undefined) {
      report.missingInLedger.push({ reference, amount: statementAmount });
    } else if (ledgerAmount !== statementAmount) {
      report.amountMismatches.push({ reference, ledgerAmount, statementAmount });
    } else {
      report.matched += 1;
    }
  }
  for (const [reference, amount] of ledgerByReference) {
    if (!statementByReference.has(reference)) report.missingInStatement.push({ reference, amount });
  }

  report.balanced =
    report.amountMismatches.length === 0 &&
    report.missingInLedger.length === 0 &&
    report.missingInStatement.length === 0 &&
    report.duplicateStatementReferences.length === 0;
  return report;
}

function netByReference(lines: StatementLine[]): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const line of lines) {
    net.set(line.reference, (net.get(line.reference) ?? 0n) + signed(line));
  }
  return net;
}

/** Loads an account's ledger activity for a period and reconciles it against a statement. */
export async function reconcileAccount(
  pool: Pool,
  input: { accountCode: string; from: Date; to: Date; statement: StatementLine[] },
): Promise<ReconciliationReport> {
  const account = await getAccount(pool, input.accountCode);
  const result = await pool.query<{ reference: string; direction: Direction; amount: bigint }>(
    `SELECT t.reference, e.direction, e.amount
     FROM entries e
     JOIN transactions t ON t.id = e.transaction_id
     WHERE e.account_id = $1 AND t.posted_at >= $2 AND t.posted_at < $3`,
    [account.id, input.from, input.to],
  );
  return reconcile(result.rows, input.statement);
}
