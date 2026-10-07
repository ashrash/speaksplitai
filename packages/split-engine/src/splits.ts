import { allocate } from './allocate';
import { alignScales, type DecimalInput, parseDecimal } from './decimal';
import { assertMinorUnits, type MinorUnits } from './money';
import type { MemberId } from './types';

/**
 * Split inputs. Participants are listed in a stable order (for example by join date); leftover
 * minor units are handed out in that order, so the same input always gives the same result.
 */
export type SplitInput =
  | { type: 'equal'; members: MemberId[] }
  | { type: 'exact'; amounts: Array<{ memberId: MemberId; amountMinor: MinorUnits }> }
  | { type: 'percent'; percents: Array<{ memberId: MemberId; percent: DecimalInput }> }
  | { type: 'shares'; shares: Array<{ memberId: MemberId; shares: DecimalInput }> }
  | {
      type: 'adjustment';
      /** Equal split of what's left after each member's fixed +/- adjustment. */
      adjustments: Array<{ memberId: MemberId; adjustmentMinor: MinorUnits }>;
    };

export interface SplitShare {
  memberId: MemberId;
  owedMinor: MinorUnits;
}

export class SplitError extends Error {
  override name = 'SplitError';
}

/** Computes what each member owes. The result always sums exactly to `totalMinor`. */
export function computeSplit(totalMinor: MinorUnits, input: SplitInput): SplitShare[] {
  assertMinorUnits(totalMinor, 'total');
  if (totalMinor <= 0) {
    throw new SplitError('total must be positive');
  }

  switch (input.type) {
    case 'equal': {
      const members = checkMembers(input.members);
      const owed = allocate(
        totalMinor,
        members.map(() => 1n),
      );
      return zip(members, owed);
    }

    case 'exact': {
      const members = checkMembers(input.amounts.map((a) => a.memberId));
      let sum = 0;
      for (const { amountMinor } of input.amounts) {
        assertMinorUnits(amountMinor);
        if (amountMinor < 0) throw new SplitError('amounts must not be negative');
        sum += amountMinor;
      }
      if (sum !== totalMinor) {
        throw new SplitError(`amounts add up to ${sum}, but the total is ${totalMinor}`);
      }
      return zip(
        members,
        input.amounts.map((a) => a.amountMinor),
      );
    }

    case 'percent': {
      const members = checkMembers(input.percents.map((p) => p.memberId));
      const { units, scale } = alignScales(input.percents.map((p) => parseDecimal(p.percent)));
      if (units.some((u) => u < 0n)) throw new SplitError('percentages must not be negative');
      const sum = units.reduce((a, b) => a + b, 0n);
      if (sum !== 100n * 10n ** BigInt(scale)) {
        throw new SplitError('percentages must add up to exactly 100');
      }
      return zip(members, allocate(totalMinor, units));
    }

    case 'shares': {
      const members = checkMembers(input.shares.map((s) => s.memberId));
      const { units } = alignScales(input.shares.map((s) => parseDecimal(s.shares)));
      if (units.some((u) => u < 0n)) throw new SplitError('shares must not be negative');
      if (units.every((u) => u === 0n)) throw new SplitError('at least one share is required');
      return zip(members, allocate(totalMinor, units));
    }

    case 'adjustment': {
      const members = checkMembers(input.adjustments.map((a) => a.memberId));
      let adjusted = 0;
      for (const { adjustmentMinor } of input.adjustments) {
        assertMinorUnits(adjustmentMinor, 'adjustment');
        adjusted += adjustmentMinor;
      }
      const remaining = totalMinor - adjusted;
      if (remaining < 0) {
        throw new SplitError('adjustments add up to more than the total');
      }
      const base = allocate(
        remaining,
        members.map(() => 1n),
      );
      const owed = base.map((b, i) => b + input.adjustments[i]!.adjustmentMinor);
      if (owed.some((o) => o < 0)) {
        throw new SplitError('an adjustment leaves a member owing less than nothing');
      }
      return zip(members, owed);
    }
  }
}

function checkMembers(members: MemberId[]): MemberId[] {
  if (members.length === 0) {
    throw new SplitError('at least one member is required');
  }
  if (new Set(members).size !== members.length) {
    throw new SplitError('each member may appear only once');
  }
  return members;
}

function zip(members: MemberId[], owed: MinorUnits[]): SplitShare[] {
  return members.map((memberId, i) => ({ memberId, owedMinor: owed[i]! }));
}
