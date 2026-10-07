/**
 * Exact decimal arithmetic on bigint. Used for every non-integer input (percentages, shares,
 * exchange rates, amounts typed in major units) so no value ever passes through a binary float.
 */

/** `units / 10^scale`, e.g. 33.33 is { units: 3333n, scale: 2 }. */
export interface Decimal {
  units: bigint;
  scale: number;
}

/** A decimal written as a string ("33.33") or a JS number whose shortest form is plain decimal. */
export type DecimalInput = string | number;

const DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;

export function parseDecimal(input: DecimalInput): Decimal {
  const text = typeof input === 'number' ? numberToPlainString(input) : input.trim();
  const match = DECIMAL_RE.exec(text);
  if (!match) {
    throw new RangeError(`not a plain decimal number: ${String(input)}`);
  }
  const [, sign, whole, fraction = ''] = match;
  const units = BigInt(`${whole}${fraction}`);
  return { units: sign === '-' ? -units : units, scale: fraction.length };
}

function numberToPlainString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`not a finite number: ${value}`);
  }
  // String() gives the shortest round-trip form ("0.1", not 0.1000000000000000055...), which is
  // the decimal the caller wrote. Exponent forms ("1e-7") are rejected by the regex.
  return String(value);
}

/** Re-expresses `d` at a larger scale without loss. */
export function rescale(d: Decimal, scale: number): bigint {
  if (scale < d.scale) {
    throw new RangeError(`cannot rescale from ${d.scale} to ${scale} decimal places without loss`);
  }
  return d.units * 10n ** BigInt(scale - d.scale);
}

/** Brings decimals to a common scale so their units can be added and compared exactly. */
export function alignScales(values: Decimal[]): { units: bigint[]; scale: number } {
  const scale = Math.max(0, ...values.map((v) => v.scale));
  return { units: values.map((v) => rescale(v, scale)), scale };
}

export type RoundingMode = 'half-even' | 'half-up' | 'truncate';

/**
 * Integer division rounded by `mode`. `half-up` rounds halves away from zero; `half-even`
 * (banker's rounding) rounds halves to the even neighbour, so repeated conversions don't drift.
 */
export function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new RangeError('division by zero');
  }
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  let q = n / denominator;
  const twiceRemainder = (n % denominator) * 2n;
  if (mode === 'half-up' && twiceRemainder >= denominator) {
    q += 1n;
  } else if (mode === 'half-even') {
    if (twiceRemainder > denominator || (twiceRemainder === denominator && q % 2n === 1n)) {
      q += 1n;
    }
  }
  return negative ? -q : q;
}
