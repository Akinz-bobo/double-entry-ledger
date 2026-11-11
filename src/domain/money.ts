import { z } from 'zod';

/**
 * Money is always an integer count of minor units (cents, kobo) held in a
 * bigint. Floats never touch an amount, so there is nothing to round.
 */

/** Keeps running totals far inside Postgres's signed 64-bit range. */
export const MAX_AMOUNT = 10n ** 17n;

export const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code like USD');

/**
 * Accepts a positive whole number as a string ("1500") or a JSON integer.
 * Strings are preferred: JSON numbers lose precision above 2^53.
 */
export const amountSchema = z
  .union([
    z.string().regex(/^[1-9]\d*$/, 'must be a positive whole number of minor units'),
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform((value) => BigInt(value))
  .refine((value) => value <= MAX_AMOUNT, 'exceeds the maximum amount');
