import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocate } from './allocate';
import { computeSplit, SplitError } from './splits';

const owed = (total: number, input: Parameters<typeof computeSplit>[1]) =>
  computeSplit(total, input).map((s) => s.owedMinor);

describe('fixed cases', () => {
  it('₹100 among 3 is 33.34 / 33.33 / 33.33', () => {
    expect(owed(10000, { type: 'equal', members: ['a', 'b', 'c'] })).toEqual([3334, 3333, 3333]);
  });

  it('1 paisa between 2 goes to the first member', () => {
    expect(owed(1, { type: 'equal', members: ['a', 'b'] })).toEqual([1, 0]);
  });

  it('¥1000 among 3 (no minor unit) is 334 / 333 / 333', () => {
    expect(owed(1000, { type: 'equal', members: ['a', 'b', 'c'] })).toEqual([334, 333, 333]);
  });

  it('33.33 / 33.33 / 33.34 percent of ₹100', () => {
    const percents = [
      { memberId: 'a', percent: '33.33' },
      { memberId: 'b', percent: '33.33' },
      { memberId: 'c', percent: '33.34' },
    ];
    expect(owed(10000, { type: 'percent', percents })).toEqual([3333, 3333, 3334]);
  });

  it('percentages given as JS numbers are read as the decimals written', () => {
    const percents = [
      { memberId: 'a', percent: 0.1 },
      { memberId: 'b', percent: 99.9 },
    ];
    expect(owed(100000, { type: 'percent', percents })).toEqual([100, 99900]);
  });

  it('rejects percentages that miss 100 by a hair', () => {
    const percents = [
      { memberId: 'a', percent: '33.33' },
      { memberId: 'b', percent: '33.33' },
      { memberId: 'c', percent: '33.33' },
    ];
    expect(() => computeSplit(10000, { type: 'percent', percents })).toThrow(SplitError);
  });

  it('2 shares vs 1 share vs 0.5 share', () => {
    const shares = [
      { memberId: 'a', shares: 2 },
      { memberId: 'b', shares: 1 },
      { memberId: 'c', shares: '0.5' },
    ];
    // exact: 5714.29 / 2857.14 / 1428.57 → floors sum to 9999; the leftover paisa goes to the
    // largest fractional remainder (c, .57), not simply the first member
    expect(owed(10000, { type: 'shares', shares })).toEqual([5714, 2857, 1429]);
  });

  it('exact amounts must add up to the total', () => {
    const amounts = [
      { memberId: 'a', amountMinor: 6000 },
      { memberId: 'b', amountMinor: 3999 },
    ];
    expect(() => computeSplit(10000, { type: 'exact', amounts })).toThrow(/add up to 9999/);
  });

  it('adjustment: equal split of the rest, plus each fixed amount', () => {
    const adjustments = [
      { memberId: 'a', adjustmentMinor: 2000 },
      { memberId: 'b', adjustmentMinor: 0 },
      { memberId: 'c', adjustmentMinor: -500 },
    ];
    // 10000 - 1500 = 8500 → 2834 / 2833 / 2833, then +2000 / 0 / -500
    expect(owed(10000, { type: 'adjustment', adjustments })).toEqual([4834, 2833, 2333]);
  });

  it('rejects duplicates, empty lists and non-integer totals', () => {
    expect(() => computeSplit(100, { type: 'equal', members: ['a', 'a'] })).toThrow(SplitError);
    expect(() => computeSplit(100, { type: 'equal', members: [] })).toThrow(SplitError);
    expect(() => computeSplit(100.5, { type: 'equal', members: ['a'] })).toThrow(RangeError);
  });

  it('stays exact beyond the float-safe range of intermediate products', () => {
    // total * weight = 9e15 * 10^4 overflows 2^53; bigint keeps it exact
    const unsafe = Number.MAX_SAFE_INTEGER + 2;
    expect(() => owed(unsafe, { type: 'equal', members: ['a'] })).toThrow(RangeError);
    const big = 8_999_999_999_999_999;
    const parts = owed(big, {
      type: 'percent',
      percents: [
        { memberId: 'a', percent: '33.3333' },
        { memberId: 'b', percent: '66.6667' },
      ],
    });
    expect(BigInt(parts[0]!) + BigInt(parts[1]!)).toBe(BigInt(big));
  });
});

describe('properties', () => {
  const total = fc.integer({ min: 1, max: 1_000_000_000_000 });
  const weights = fc
    .array(fc.bigInt({ min: 0n, max: 1_000_000n }), { minLength: 1, maxLength: 50 })
    .filter((ws) => ws.some((w) => w > 0n));

  it('allocations always sum exactly to the total', () => {
    fc.assert(
      fc.property(total, weights, (t, ws) => {
        const parts = allocate(t, ws);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(t);
      }),
    );
  });

  it('every part is within one minor unit of its exact share', () => {
    fc.assert(
      fc.property(total, weights, (t, ws) => {
        const sum = ws.reduce((a, b) => a + b, 0n);
        allocate(t, ws).forEach((part, i) => {
          // |part - t*w/sum| < 1  ⇔  |part*sum - t*w| < sum
          const diff = BigInt(part) * sum - BigInt(t) * ws[i]!;
          expect(diff < sum && diff > -sum).toBe(true);
        });
      }),
    );
  });

  it('zero weight gets nothing and parts are never negative', () => {
    fc.assert(
      fc.property(total, weights, (t, ws) => {
        allocate(t, ws).forEach((part, i) => {
          expect(part).toBeGreaterThanOrEqual(0);
          if (ws[i] === 0n) expect(part).toBe(0);
        });
      }),
    );
  });

  it('equal splits differ by at most one minor unit', () => {
    fc.assert(
      fc.property(total, fc.integer({ min: 1, max: 100 }), (t, n) => {
        const members = Array.from({ length: n }, (_, i) => `m${i}`);
        const parts = owed(t, { type: 'equal', members });
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(t);
      }),
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(total, weights, (t, ws) => {
        expect(allocate(t, ws)).toEqual(allocate(t, ws));
      }),
    );
  });
});
