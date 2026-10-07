import { describe, expect, it } from 'vitest';
import { assertPaise, isPaise } from './paise';

describe('paise', () => {
  it('accepts integers and rejects fractions', () => {
    expect(isPaise(10000)).toBe(true);
    expect(isPaise(-1)).toBe(true);
    expect(isPaise(100.5)).toBe(false);
    expect(isPaise('100')).toBe(false);
  });

  it('assertPaise throws on non-integers', () => {
    expect(() => assertPaise(0.1)).toThrow(RangeError);
  });
});
