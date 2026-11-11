/**
 * An error the caller can act on. Each one carries a stable machine-readable
 * code and the HTTP status it maps to, so the transport layer needs no
 * knowledge of the ledger's rules.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const errors = {
  accountNotFound: (codes: string[]) =>
    new DomainError('account_not_found', `Unknown account: ${codes.join(', ')}`, 404, { codes }),
  accountExists: (code: string) =>
    new DomainError('account_exists', `Account ${code} already exists`, 409, { code }),
  transactionNotFound: (id: string) =>
    new DomainError('transaction_not_found', `Unknown transaction: ${id}`, 404, { id }),
  duplicateReference: (reference: string) =>
    new DomainError(
      'duplicate_reference',
      `A transaction with reference ${reference} has already been posted`,
      409,
      { reference },
    ),
  unbalanced: (currency: string, debits: bigint, credits: bigint) =>
    new DomainError(
      'unbalanced_transaction',
      `Debits (${debits}) do not equal credits (${credits}) for ${currency}`,
      422,
      { currency, debits: debits.toString(), credits: credits.toString() },
    ),
  tooFewEntries: () =>
    new DomainError('too_few_entries', 'A transaction needs at least two entries', 422),
  insufficientFunds: (code: string) =>
    new DomainError('insufficient_funds', `Account ${code} cannot go below zero`, 422, { code }),
  alreadyReversed: (id: string) =>
    new DomainError('already_reversed', `Transaction ${id} has already been reversed`, 409, { id }),
  cannotReverseReversal: (id: string) =>
    new DomainError('cannot_reverse_reversal', `Transaction ${id} is itself a reversal`, 422, {
      id,
    }),
  idempotencyKeyReused: () =>
    new DomainError(
      'idempotency_key_reused',
      'This Idempotency-Key was already used with a different request',
      422,
    ),
  idempotencyKeyRequired: () =>
    new DomainError('idempotency_key_required', 'The Idempotency-Key header is required', 400),
  holdNotFound: (id: string) =>
    new DomainError('hold_not_found', `Unknown hold: ${id}`, 404, { id }),
  holdNotPending: (id: string, status: string) =>
    new DomainError('hold_not_pending', `Hold ${id} is already ${status}`, 409, { id, status }),
  holdExpired: (id: string) =>
    new DomainError('hold_expired', `Hold ${id} has expired`, 409, { id }),
  captureExceedsHold: (id: string) =>
    new DomainError('capture_exceeds_hold', `Cannot capture more than hold ${id} reserved`, 422, {
      id,
    }),
  invalidCursor: () => new DomainError('invalid_cursor', 'The cursor is not valid', 400),
  unauthorized: () => new DomainError('unauthorized', 'Missing or invalid API key', 401),
  forbidden: (scope: string) =>
    new DomainError('forbidden', `This API key does not have the ${scope} scope`, 403, { scope }),
};
