import { fromBigInt, type MinorUnits } from './money';

/**
 * Splits `total` minor units in proportion to `weights` so the parts sum to `total` exactly.
 *
 * Largest-remainder method: each part gets floor(total * w / W); the leftover units (fewer than
 * the number of parts) go one each to the parts with the largest fractional remainder, ties
 * going to the earlier index. Every part is within one minor unit of its exact share, and the
 * result depends only on the inputs and their order, so every client and the server agree.
 */
export function allocate(total: MinorUnits, weights: readonly bigint[]): MinorUnits[] {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError(`total must be a non-negative integer, got ${total}`);
  }
  if (weights.length === 0) {
    throw new RangeError('at least one weight is required');
  }
  if (weights.some((w) => w < 0n)) {
    throw new RangeError('weights must not be negative');
  }
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) {
    throw new RangeError('weights must not all be zero');
  }

  const t = BigInt(total);
  const parts = weights.map((w) => (t * w) / sum);
  const remainders = weights.map((w, index) => ({ index, remainder: (t * w) % sum }));
  let leftover = t - parts.reduce((a, b) => a + b, 0n);

  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const { index } of remainders) {
    if (leftover === 0n) break;
    parts[index]! += 1n;
    leftover -= 1n;
  }
  return parts.map((p) => fromBigInt(p));
}
