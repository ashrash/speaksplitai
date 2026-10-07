import { minorUnitOf } from './currency';
import { type DecimalInput, divRound, parseDecimal, type RoundingMode } from './decimal';

/**
 * An amount in the currency's smallest unit (paise for INR, cents for USD, yen for JPY).
 * Always an integer; kept within Number.MAX_SAFE_INTEGER so it is exact as a JS number and fits
 * the database's bigint columns.
 */
export type MinorUnits = number;

export function isMinorUnits(value: unknown): value is MinorUnits {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertMinorUnits(value: unknown, label = 'amount'): asserts value is MinorUnits {
  if (!isMinorUnits(value)) {
    throw new RangeError(`${label} must be an integer number of minor units, got ${String(value)}`);
  }
}

/** Converts a bigint result back to MinorUnits, refusing anything outside the exact range. */
export function fromBigInt(value: bigint, label = 'amount'): MinorUnits {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${label} is too large: ${value}`);
  }
  return Number(value);
}

/**
 * Parses an amount written in major units ("1234.5" INR) into minor units (123450).
 * More decimal places than the currency has is an error, unless a rounding mode is given
 * (for example for OCR'd receipts): we never round money silently.
 */
export function toMinor(
  amount: DecimalInput,
  currency: string,
  options: { rounding?: RoundingMode } = {},
): MinorUnits {
  const exponent = minorUnitOf(currency);
  const d = parseDecimal(amount);
  if (d.scale <= exponent) {
    return fromBigInt(d.units * 10n ** BigInt(exponent - d.scale));
  }
  const divisor = 10n ** BigInt(d.scale - exponent);
  if (d.units % divisor !== 0n && !options.rounding) {
    throw new RangeError(
      `${String(amount)} has more decimal places than ${currency} allows (${exponent})`,
    );
  }
  return fromBigInt(divRound(d.units, divisor, options.rounding ?? 'truncate'));
}

/** Formats minor units as a plain major-unit string ("1234.50"). Use Intl for display. */
export function formatMinor(amount: MinorUnits, currency: string): string {
  assertMinorUnits(amount);
  const exponent = minorUnitOf(currency);
  const negative = amount < 0;
  const digits = String(Math.abs(amount)).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? '-' : ''}${whole}${exponent > 0 ? `.${fraction}` : ''}`;
}

/**
 * Converts between currencies at `rate` (units of `to` per one unit of `from`, e.g. 83.1234 INR
 * per USD), accounting for different minor-unit exponents, rounded once at the end.
 */
export function convertMinor(
  amount: MinorUnits,
  from: string,
  to: string,
  rate: DecimalInput,
  rounding: RoundingMode = 'half-even',
): MinorUnits {
  assertMinorUnits(amount);
  const r = parseDecimal(rate);
  if (r.units <= 0n) {
    throw new RangeError(`exchange rate must be positive, got ${String(rate)}`);
  }
  const shift = minorUnitOf(to) - minorUnitOf(from) - r.scale;
  const numerator = BigInt(amount) * r.units * (shift > 0 ? 10n ** BigInt(shift) : 1n);
  const denominator = shift < 0 ? 10n ** BigInt(-shift) : 1n;
  return fromBigInt(divRound(numerator, denominator, rounding));
}
