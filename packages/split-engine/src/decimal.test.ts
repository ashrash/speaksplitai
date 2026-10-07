import { describe, expect, it } from 'vitest';
import { alignScales, divRound, parseDecimal } from './decimal';

describe('parseDecimal', () => {
  it.each([
    ['33.33', 3333n, 2],
    ['100', 100n, 0],
    ['-0.5', -5n, 1],
    [0.1, 1n, 1],
    [12.5, 125n, 1],
  ])('parses %s exactly', (input, units, scale) => {
    expect(parseDecimal(input)).toEqual({ units, scale });
  });

  it.each(['1e-7', '1,000', '', 'abc', NaN, Infinity, 1e21])('rejects %s', (input) => {
    expect(() => parseDecimal(input)).toThrow(RangeError);
  });

  it('aligns scales without loss', () => {
    expect(alignScales([parseDecimal('1.5'), parseDecimal('2.25')])).toEqual({
      units: [150n, 225n],
      scale: 2,
    });
  });
});

describe('divRound', () => {
  it.each([
    [5n, 2n, 'half-even', 2n],
    [7n, 2n, 'half-even', 4n],
    [-5n, 2n, 'half-even', -2n],
    [5n, 2n, 'half-up', 3n],
    [-5n, 2n, 'half-up', -3n],
    [7n, 3n, 'half-up', 2n],
    [8n, 3n, 'half-up', 3n],
    [9n, 2n, 'truncate', 4n],
    [-9n, 2n, 'truncate', -4n],
  ] as const)('%s / %s (%s) = %s', (n, d, mode, expected) => {
    expect(divRound(n, d, mode)).toBe(expected);
  });
});
