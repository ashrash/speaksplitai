import type { Paise } from './types';

export function isPaise(value: unknown): value is Paise {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertPaise(value: unknown, label = 'amount'): asserts value is Paise {
  if (!isPaise(value)) {
    throw new RangeError(`${label} must be an integer number of paise, got ${String(value)}`);
  }
}
