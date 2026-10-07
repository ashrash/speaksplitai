import { allocate } from './allocate';
import { fromBigInt, type MinorUnits } from './money';
import type { MemberId } from './types';

/** An expense as far as balances are concerned. Soft-deleted expenses are left out by the caller. */
export interface LedgerExpense {
  currency: string;
  payers: Array<{ memberId: MemberId; paidMinor: MinorUnits }>;
  splits: Array<{ memberId: MemberId; owedMinor: MinorUnits }>;
}

export type SettlementStatus = 'pending' | 'confirmed' | 'disputed' | 'cancelled';

/** A payment between members. `amountMinor` + `currency` is the debt it clears. */
export interface LedgerSettlement {
  currency: string;
  fromMemberId: MemberId;
  toMemberId: MemberId;
  amountMinor: MinorUnits;
  status: SettlementStatus;
}

export interface Ledger {
  expenses: LedgerExpense[];
  settlements: LedgerSettlement[];
}

/**
 * One member's position in one currency. Mirrors the `member_balances` view:
 * netMinor > 0 means the member should receive money, < 0 means they owe.
 * Only confirmed settlements move the net; pending ones are reported separately.
 */
export interface MemberBalance {
  memberId: MemberId;
  currency: string;
  paidMinor: MinorUnits;
  owedMinor: MinorUnits;
  netMinor: MinorUnits;
  pendingSentMinor: MinorUnits;
  pendingReceivedMinor: MinorUnits;
}

/** "from owes to amountMinor", in one currency. */
export interface Transfer {
  fromMemberId: MemberId;
  toMemberId: MemberId;
  currency: string;
  amountMinor: MinorUnits;
}

export class LedgerError extends Error {
  override name = 'LedgerError';
}

interface Acc {
  paid: bigint;
  owed: bigint;
  sent: bigint;
  received: bigint;
  pendingSent: bigint;
  pendingReceived: bigint;
}

/**
 * Net balance of every member, per currency. Amounts in different currencies are never added
 * together. Sorted by currency, then member id, so every client gets the same order.
 */
export function computeBalances(ledger: Ledger): MemberBalance[] {
  const accs = new Map<string, Map<MemberId, Acc>>();
  const acc = (currency: string, memberId: MemberId): Acc => {
    let byMember = accs.get(currency);
    if (!byMember) accs.set(currency, (byMember = new Map()));
    let a = byMember.get(memberId);
    if (!a) {
      a = { paid: 0n, owed: 0n, sent: 0n, received: 0n, pendingSent: 0n, pendingReceived: 0n };
      byMember.set(memberId, a);
    }
    return a;
  };

  ledger.expenses.forEach((expense, i) => {
    checkExpense(expense, i);
    for (const p of expense.payers) acc(expense.currency, p.memberId).paid += BigInt(p.paidMinor);
    for (const s of expense.splits) acc(expense.currency, s.memberId).owed += BigInt(s.owedMinor);
  });

  for (const s of ledger.settlements) {
    checkSettlement(s);
    const amount = BigInt(s.amountMinor);
    const from = acc(s.currency, s.fromMemberId);
    const to = acc(s.currency, s.toMemberId);
    if (s.status === 'confirmed') {
      from.sent += amount;
      to.received += amount;
    } else if (s.status === 'pending') {
      from.pendingSent += amount;
      to.pendingReceived += amount;
    }
  }

  const result: MemberBalance[] = [];
  for (const currency of [...accs.keys()].sort()) {
    const byMember = accs.get(currency)!;
    for (const memberId of [...byMember.keys()].sort()) {
      const a = byMember.get(memberId)!;
      result.push({
        memberId,
        currency,
        paidMinor: fromBigInt(a.paid),
        owedMinor: fromBigInt(a.owed),
        netMinor: fromBigInt(a.paid - a.owed + a.sent - a.received),
        pendingSentMinor: fromBigInt(a.pendingSent),
        pendingReceivedMinor: fromBigInt(a.pendingReceived),
      });
    }
  }
  return result;
}

/**
 * Who owes whom without simplification (for groups with simplify_debts off): within each
 * expense, every member who paid less than their share owes the members who paid more, in
 * proportion to how much more each paid (rounded so every creditor receives exactly their excess).
 * Debts are then netted per pair and per currency, and
 * confirmed settlements are applied. Sorted by currency, debtor, creditor.
 */
export function pairwiseDebts(ledger: Ledger): Transfer[] {
  // currency -> "a\u0000b" (a < b) -> amount a owes b (negative: b owes a)
  const pairs = new Map<string, Map<string, bigint>>();
  const add = (currency: string, debtor: MemberId, creditor: MemberId, amount: bigint) => {
    if (debtor === creditor || amount === 0n) return;
    let byPair = pairs.get(currency);
    if (!byPair) pairs.set(currency, (byPair = new Map()));
    const [a, b, signed] =
      debtor < creditor ? [debtor, creditor, amount] : [creditor, debtor, -amount];
    const key = `${a}\u0000${b}`;
    byPair.set(key, (byPair.get(key) ?? 0n) + signed);
  };

  ledger.expenses.forEach((expense, i) => {
    checkExpense(expense, i);
    const net = new Map<MemberId, bigint>();
    for (const p of expense.payers)
      net.set(p.memberId, (net.get(p.memberId) ?? 0n) + BigInt(p.paidMinor));
    for (const s of expense.splits)
      net.set(s.memberId, (net.get(s.memberId) ?? 0n) - BigInt(s.owedMinor));
    const ids = [...net.keys()].sort();
    const creditors = ids.filter((id) => net.get(id)! > 0n);
    const debtors = ids.filter((id) => net.get(id)! < 0n);
    if (creditors.length === 0) return;
    // Each debtor's amount is shared in proportion to what each creditor is still owed, so
    // rounding can never over- or under-pay a creditor: the last debtor fills exactly what's left.
    const remaining = creditors.map((id) => net.get(id)!);
    for (const debtor of debtors) {
      const shares = allocate(fromBigInt(-net.get(debtor)!), remaining);
      shares.forEach((share, j) => {
        remaining[j]! -= BigInt(share);
        add(expense.currency, debtor, creditors[j]!, BigInt(share));
      });
    }
  });

  for (const s of ledger.settlements) {
    checkSettlement(s);
    // paying clears what the payer owed the payee
    if (s.status === 'confirmed')
      add(s.currency, s.toMemberId, s.fromMemberId, BigInt(s.amountMinor));
  }

  const result: Transfer[] = [];
  for (const currency of [...pairs.keys()].sort()) {
    for (const [key, amount] of pairs.get(currency)!) {
      if (amount === 0n) continue;
      const [a, b] = key.split('\u0000') as [MemberId, MemberId];
      result.push(
        amount > 0n
          ? { fromMemberId: a, toMemberId: b, currency, amountMinor: fromBigInt(amount) }
          : { fromMemberId: b, toMemberId: a, currency, amountMinor: fromBigInt(-amount) },
      );
    }
  }
  return result.sort(
    (x, y) =>
      cmp(x.currency, y.currency) ||
      cmp(x.fromMemberId, y.fromMemberId) ||
      cmp(x.toMemberId, y.toMemberId),
  );
}

function checkExpense(expense: LedgerExpense, index: number): void {
  let paid = 0n;
  let owed = 0n;
  for (const p of expense.payers) {
    checkAmount(p.paidMinor, `expense ${index} payer amount`);
    paid += BigInt(p.paidMinor);
  }
  for (const s of expense.splits) {
    checkAmount(s.owedMinor, `expense ${index} split amount`);
    owed += BigInt(s.owedMinor);
  }
  if (paid !== owed) {
    throw new LedgerError(`expense ${index}: payers add up to ${paid} but splits to ${owed}`);
  }
}

function checkSettlement(s: LedgerSettlement): void {
  checkAmount(s.amountMinor, 'settlement amount');
  if (s.amountMinor === 0) throw new LedgerError('settlement amount must be positive');
  if (s.fromMemberId === s.toMemberId) throw new LedgerError('a member cannot pay themselves');
}

function checkAmount(value: MinorUnits, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LedgerError(`${label} must be a non-negative integer, got ${value}`);
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
