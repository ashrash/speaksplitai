import { describe, expect, it } from 'vitest';
import { minorUnitsTransformer } from './transformers.js';

describe('minorUnitsTransformer', () => {
  it('reads bigint strings as exact numbers', () => {
    expect(minorUnitsTransformer.from('5000000000')).toBe(5_000_000_000);
    expect(minorUnitsTransformer.from('-3333')).toBe(-3333);
    expect(minorUnitsTransformer.from(null)).toBeNull();
  });

  it('refuses values a JS number cannot hold exactly', () => {
    expect(() => minorUnitsTransformer.from('9007199254740993')).toThrow(RangeError);
  });
});
