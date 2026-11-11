import { z } from 'zod';
import { amountSchema, currencySchema } from '../domain/money.js';
import { ACCOUNT_TYPES } from '../ledger/types.js';

const accountCode = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9:._-]*$/, 'use lowercase letters, digits and : . _ -');

const reference = z.string().min(1).max(128);
const direction = z.enum(['debit', 'credit']);

const entry = z.strictObject({ accountCode, direction, amount: amountSchema });

export const createAccountBody = z.strictObject({
  code: accountCode,
  name: z.string().min(1).max(200),
  type: z.enum(ACCOUNT_TYPES),
  currency: currencySchema,
  allowNegative: z.boolean().default(false),
});

export const postTransactionBody = z.strictObject({
  reference,
  description: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  entries: z.array(entry).min(2).max(100),
});

export const reverseTransactionBody = z.strictObject({
  reference: reference.optional(),
  description: z.string().max(500).optional(),
});

export const reconcileBody = z
  .strictObject({
    accountCode,
    from: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    to: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    statement: z.array(z.strictObject({ reference, direction, amount: amountSchema })).max(10_000),
  })
  .refine((body) => body.from < body.to, { message: '`from` must be before `to`', path: ['from'] });

export const accountParams = z.strictObject({ code: accountCode });
export const transactionParams = z.strictObject({ id: z.uuid() });

export const entriesQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z
    .string()
    .regex(/^\d+$/)
    .transform((value) => BigInt(value))
    .optional(),
});

export const idempotencyKey = z.string().min(8).max(255);
