import type { Pool } from '../db/pool.js';

export interface TrialBalanceLine {
  currency: string;
  debits: bigint;
  credits: bigint;
  balanced: boolean;
}

/**
 * Totals every account's debits and credits, per currency. In a healthy
 * ledger the two are always equal; a difference means the books are corrupt.
 * Cheap to run, so it suits a scheduled health check.
 */
export async function trialBalance(pool: Pool): Promise<TrialBalanceLine[]> {
  const result = await pool.query<{ currency: string; debits: string; credits: string }>(
    `SELECT currency,
            sum(debits_posted)::text AS debits,
            sum(credits_posted)::text AS credits
     FROM accounts
     GROUP BY currency
     ORDER BY currency`,
  );
  return result.rows.map((row) => {
    const debits = BigInt(row.debits);
    const credits = BigInt(row.credits);
    return { currency: row.currency, debits, credits, balanced: debits === credits };
  });
}
