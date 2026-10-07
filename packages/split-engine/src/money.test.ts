import { describe, expect, it } from 'vitest';
import { convertMinor, formatMinor, toMinor } from './money';

describe('toMinor', () => {
  it.each([
    ['1234.5', 'INR', 123450],
    ['0.01', 'INR', 1],
    ['1000', 'JPY', 1000],
    ['1.234', 'KWD', 1234],
    [0.1, 'USD', 10],
    [19.99, 'USD', 1999],
  ])('%s %s = %s minor units', (amount, currency, expected) => {
    expect(toMinor(amount, currency)).toBe(expected);
  });

  it('refuses more precision than the currency has', () => {
    expect(() => toMinor('1.005', 'INR')).toThrow(/decimal places/);
    expect(() => toMinor('10.5', 'JPY')).toThrow(/decimal places/);
  });

  it('rounds only when asked to', () => {
    expect(toMinor('1.005', 'INR', { rounding: 'half-up' })).toBe(101);
    expect(toMinor('1.005', 'INR', { rounding: 'half-even' })).toBe(100);
  });

  it('rejects unknown currencies', () => {
    expect(() => toMinor('1', 'XYZ')).toThrow(/unsupported currency/);
  });
});

describe('formatMinor', () => {
  it.each([
    [123450, 'INR', '1234.50'],
    [5, 'INR', '0.05'],
    [-5, 'INR', '-0.05'],
    [1000, 'JPY', '1000'],
    [1234, 'KWD', '1.234'],
  ])('%s %s = %s', (amount, currency, expected) => {
    expect(formatMinor(amount, currency)).toBe(expected);
  });
});

describe('convertMinor', () => {
  it('converts USD cents to INR paise at a 4-decimal rate', () => {
    // $100.00 at 83.1234 INR/USD = ₹8312.34
    expect(convertMinor(10000, 'USD', 'INR', '83.1234')).toBe(831234);
  });

  it('handles different minor-unit exponents', () => {
    // ¥1000 at 0.5612 INR/JPY = ₹561.20
    expect(convertMinor(1000, 'JPY', 'INR', '0.5612')).toBe(56120);
    // ₹561.20 at 1.7819 JPY/INR = ¥999.997... → ¥1000
    expect(convertMinor(56120, 'INR', 'JPY', '1.7819')).toBe(1000);
    // 1.234 KWD at 270.5 INR/KWD = ₹333.797 → ₹333.80
    expect(convertMinor(1234, 'KWD', 'INR', '270.5')).toBe(33380);
  });

  it('rounds half to even by default', () => {
    // 1 cent at 0.5 → 0.5 paise: half-even gives 0, half-up gives 1
    expect(convertMinor(1, 'USD', 'EUR', '0.5')).toBe(0);
    expect(convertMinor(1, 'USD', 'EUR', '0.5', 'half-up')).toBe(1);
  });

  it('rejects non-positive rates', () => {
    expect(() => convertMinor(100, 'USD', 'INR', '0')).toThrow(RangeError);
  });
});
