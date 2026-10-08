import { describe, expect, it } from 'vitest';
import { upiPayUri } from './upi';

describe('upiPayUri', () => {
  it('builds a pay link with the amount in rupees and encoded text', () => {
    expect(
      upiPayUri({
        vpa: 'asha@okaxis',
        name: 'Asha R',
        amountMinor: 123450,
        note: 'Goa trip & dinner',
        ref: 'SS12AB',
      }),
    ).toBe(
      'upi://pay?pa=asha%40okaxis&pn=Asha%20R&am=1234.50&cu=INR&tn=Goa%20trip%20%26%20dinner&tr=SS12AB',
    );
  });

  it('leaves out an empty note and reference, and trims long text', () => {
    const uri = upiPayUri({ vpa: 'bb@ybl', name: 'B'.repeat(80), amountMinor: 5, note: '  ' });
    expect(uri).toBe(`upi://pay?pa=bb%40ybl&pn=${'B'.repeat(50)}&am=0.05&cu=INR`);
  });

  it.each([
    [{ vpa: 'not a vpa', name: 'x', amountMinor: 100 }],
    [{ vpa: 'a@okaxis', name: 'x', amountMinor: 0 }],
    [{ vpa: 'a@okaxis', name: 'x', amountMinor: 1.5 }],
    [{ vpa: 'a@okaxis', name: 'x', amountMinor: 100, ref: 'has space' }],
  ])('rejects %o', (link) => {
    expect(() => upiPayUri(link)).toThrow(RangeError);
  });
});
