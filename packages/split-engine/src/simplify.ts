import { type MemberBalance, type Transfer, LedgerError } from './balances';
import { fromBigInt } from './money';
import type { MemberId } from './types';

/** Above this many members with a non-zero balance, the exact search is skipped (2^n states). */
export const EXACT_SIMPLIFY_LIMIT = 16;

export interface SimplifyOptions {
  /**
   * Find the fewest possible transfers (exact for up to EXACT_SIMPLIFY_LIMIT members with a
   * non-zero balance; greedy beyond that). Default true. With false, always greedy.
   */
  exact?: boolean;
}

/**
 * Settles every balance with as few transfers as possible, separately for each currency.
 * Only `netMinor` is used, so pass balances that already include confirmed settlements.
 *
 * Greedy step: the member who owes most pays the member owed most, as much as both allow,
 * until everyone is at zero. That needs at most n - 1 transfers. The exact step first splits
 * members into the largest number of groups whose balances sum to zero; settling each group
 * separately then needs n - (number of groups) transfers, which is the minimum.
 * Ties are broken by member id, so every client gets the same plan.
 */
export function simplifyDebts(
  balances: Array<Pick<MemberBalance, 'memberId' | 'currency' | 'netMinor'>>,
  options: SimplifyOptions = {},
): Transfer[] {
  const byCurrency = new Map<string, Map<MemberId, bigint>>();
  for (const b of balances) {
    if (!Number.isSafeInteger(b.netMinor)) {
      throw new LedgerError(`balance must be an integer, got ${b.netMinor}`);
    }
    let m = byCurrency.get(b.currency);
    if (!m) byCurrency.set(b.currency, (m = new Map()));
    m.set(b.memberId, (m.get(b.memberId) ?? 0n) + BigInt(b.netMinor));
  }

  const transfers: Transfer[] = [];
  for (const currency of [...byCurrency.keys()].sort()) {
    const nets = [...byCurrency.get(currency)!]
      .filter(([, net]) => net !== 0n)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const total = nets.reduce((sum, [, net]) => sum + net, 0n);
    if (total !== 0n) {
      throw new LedgerError(`${currency} balances sum to ${total}, not zero`);
    }
    const groups =
      options.exact !== false && nets.length <= EXACT_SIMPLIFY_LIMIT ? zeroSumGroups(nets) : [nets];
    for (const group of groups) {
      transfers.push(...greedy(group, currency));
    }
  }
  return transfers;
}

function greedy(nets: Array<[MemberId, bigint]>, currency: string): Transfer[] {
  const people = nets.map(([memberId, net]) => ({ memberId, net }));
  const transfers: Transfer[] = [];
  for (;;) {
    let debtor: (typeof people)[number] | undefined;
    let creditor: (typeof people)[number] | undefined;
    for (const p of people) {
      if (p.net < 0n && (!debtor || p.net < debtor.net)) debtor = p;
      if (p.net > 0n && (!creditor || p.net > creditor.net)) creditor = p;
    }
    if (!debtor || !creditor) return transfers;
    const amount = -debtor.net < creditor.net ? -debtor.net : creditor.net;
    transfers.push({
      fromMemberId: debtor.memberId,
      toMemberId: creditor.memberId,
      currency,
      amountMinor: fromBigInt(amount),
    });
    debtor.net += amount;
    creditor.net -= amount;
  }
}

/**
 * Partitions members into the maximum number of groups that each sum to zero.
 * dp[mask] = the most zero-sum prefixes over orderings of the members in mask; walking an
 * optimal ordering back and cutting at each zero prefix gives the groups.
 */
function zeroSumGroups(nets: Array<[MemberId, bigint]>): Array<Array<[MemberId, bigint]>> {
  const n = nets.length;
  if (n === 0) return [];
  const size = 1 << n;
  const sum = new Array<bigint>(size).fill(0n);
  const dp = new Int8Array(size);
  for (let mask = 1; mask < size; mask++) {
    const low = mask & -mask;
    const i = 31 - Math.clz32(low);
    sum[mask] = sum[mask ^ low]! + nets[i]![1];
    let best = 0;
    for (let bits = mask; bits; bits &= bits - 1) {
      const without = mask ^ (bits & -bits);
      if (dp[without]! > best) best = dp[without]!;
    }
    dp[mask] = best + (sum[mask] === 0n ? 1 : 0);
  }

  // Walk back: repeatedly drop the lowest-index member that keeps the optimum, recording the
  // order; a group closes wherever the remaining set sums to zero.
  const groups: Array<Array<[MemberId, bigint]>> = [];
  let current: Array<[MemberId, bigint]> = [];
  let mask = size - 1;
  while (mask) {
    const bonus = sum[mask] === 0n ? 1 : 0;
    if (bonus && current.length) {
      groups.push(current);
      current = [];
    }
    for (let i = 0; i < n; i++) {
      const bit = 1 << i;
      if (mask & bit && dp[mask ^ bit]! + bonus === dp[mask]) {
        current.push(nets[i]!);
        mask ^= bit;
        break;
      }
    }
  }
  groups.push(current);
  return groups.map((g) => g.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).reverse();
}
