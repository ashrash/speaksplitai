import { describe, expect, it } from 'vitest';
import { decimalStringSchema, moneySchema } from './index';

describe('moneySchema', () => {
  it('accepts integer minor units in a known currency', () => {
    expect(moneySchema.parse({ amountMinor: 123450, currency: 'INR' })).toEqual({
      amountMinor: 123450,
      currency: 'INR',
    });
  });

  it.each([
    { amountMinor: 12.5, currency: 'INR' },
    { amountMinor: Number.MAX_SAFE_INTEGER + 2, currency: 'INR' },
    { amountMinor: 100, currency: 'XYZ' },
  ])('rejects %o', (value) => {
    expect(moneySchema.safeParse(value).success).toBe(false);
  });
});

describe('decimalStringSchema', () => {
  it('accepts plain decimals only', () => {
    expect(decimalStringSchema.safeParse('33.33').success).toBe(true);
    expect(decimalStringSchema.safeParse('1e-7').success).toBe(false);
  });
});
