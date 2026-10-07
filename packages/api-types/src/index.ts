import { CURRENCY_CODES, SPLIT_TYPES } from '@speaksplit/split-engine';
import { z } from 'zod';

export const uuidSchema = z.uuid();
export const splitTypeSchema = z.enum(SPLIT_TYPES);
export const currencySchema = z.enum(CURRENCY_CODES);

/** An integer count of the currency's minor unit (paise, cents, yen). Never a float. */
export const minorUnitsSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

/** Amounts always travel with their currency. */
export const moneySchema = z.object({
  amountMinor: minorUnitsSchema,
  currency: currencySchema,
});
export type Money = z.infer<typeof moneySchema>;

/** Percentages, shares and exchange rates travel as decimal strings to avoid float rounding. */
export const decimalStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected a decimal string');

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
