import { fromBigInt, type MinorUnits } from '@speaksplit/split-engine';
import type { ValueTransformer } from 'typeorm';

/**
 * Money columns are Postgres bigint, which node-postgres returns as strings. This maps them to
 * exact JS integers (refusing anything beyond Number.MAX_SAFE_INTEGER) and back.
 * Use with `@Column('bigint', { transformer: minorUnitsTransformer })`.
 */
export const minorUnitsTransformer: ValueTransformer = {
  to: (value: MinorUnits | null | undefined) => value,
  from: (value: string | null): MinorUnits | null =>
    value === null ? null : fromBigInt(BigInt(value)),
};
