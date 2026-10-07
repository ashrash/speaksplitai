import { describe, expect, it } from 'vitest';
import { canonicalJson } from './idempotency.js';

describe('canonicalJson', () => {
  it('ignores key order at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
  });

  it('keeps array order', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});
