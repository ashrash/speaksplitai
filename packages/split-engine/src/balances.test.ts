import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeBalances, type Ledger, LedgerError, pairwiseDebts } from './balances';
import { simplifyDebts } from './simplify';
import { computeSplit } from './splits';

/** ₹100 paid by a, split equally among a, b, c. */
const dinner = {
  currency: 'INR',
  payers: [{ memberId: 'a', paidMinor: 10000 }],
  splits: computeSplit(10000, { type: 'equal', members: ['a', 'b', 'c'] }).map((s) => ({
    memberId: s.memberId,
    owedMinor: s.owedMinor,
  })),
};

const net = (ledger: Ledger, currency = 'INR') =>
  Object.fromEntries(
    computeBalances(ledger)
      .filter((b) => b.currency === currency)
      .map((b) => [b.memberId, b.netMinor]),
  );

describe('computeBalances', () => {
  it('nets an expense: payer is owed, others owe', () => {
    expect(net({ expenses: [dinner], settlements: [] })).toEqual({ a: 6666, b: -3333, c: -3333 });
  });

  it('applies confirmed settlements and reports pending ones separately', () => {
    const balances = computeBalances({
      expenses: [dinner],
      settlements: [
        {
          currency: 'INR',
          fromMemberId: 'b',
          toMemberId: 'a',
          amountMinor: 3333,
          status: 'confirmed',
        },
        {
          currency: 'INR',
          fromMemberId: 'c',
          toMemberId: 'a',
          amountMinor: 1000,
          status: 'pending',
        },
        {
          currency: 'INR',
          fromMemberId: 'c',
          toMemberId: 'a',
          amountMinor: 500,
          status: 'cancelled',
        },
        {
          currency: 'INR',
          fromMemberId: 'c',
          toMemberId: 'a',
          amountMinor: 700,
          status: 'disputed',
        },
      ],
    });
    expect(balances).toEqual([
      {
        memberId: 'a',
        currency: 'INR',
        paidMinor: 10000,
        owedMinor: 3334,
        netMinor: 3333,
        pendingSentMinor: 0,
        pendingReceivedMinor: 1000,
      },
      {
        memberId: 'b',
        currency: 'INR',
        paidMinor: 0,
        owedMinor: 3333,
        netMinor: 0,
        pendingSentMinor: 0,
        pendingReceivedMinor: 0,
      },
      {
        memberId: 'c',
        currency: 'INR',
        paidMinor: 0,
        owedMinor: 3333,
        netMinor: -3333,
        pendingSentMinor: 1000,
        pendingReceivedMinor: 0,
      },
    ]);
  });

  it('keeps currencies apart', () => {
    const ledger: Ledger = {
      expenses: [
        dinner,
        {
          currency: 'USD',
          payers: [{ memberId: 'b', paidMinor: 3000 }],
          splits: [
            { memberId: 'a', owedMinor: 1500 },
            { memberId: 'b', owedMinor: 1500 },
          ],
        },
      ],
      settlements: [],
    };
    expect(net(ledger, 'INR')).toEqual({ a: 6666, b: -3333, c: -3333 });
    expect(net(ledger, 'USD')).toEqual({ a: -1500, b: 1500 });
  });

  it('handles multiple payers and a payer who is not in the split', () => {
    const ledger: Ledger = {
      expenses: [
        {
          currency: 'INR',
          payers: [
            { memberId: 'a', paidMinor: 6000 },
            { memberId: 'd', paidMinor: 4000 },
          ],
          splits: [
            { memberId: 'a', owedMinor: 5000 },
            { memberId: 'b', owedMinor: 5000 },
          ],
        },
      ],
      settlements: [],
    };
    expect(net(ledger)).toEqual({ a: 1000, b: -5000, d: 4000 });
  });

  it('rejects an expense whose payers and splits disagree', () => {
    const bad = { ...dinner, splits: dinner.splits.slice(1) };
    expect(() => computeBalances({ expenses: [bad], settlements: [] })).toThrow(LedgerError);
  });

  it('rejects self-payments and non-integer amounts', () => {
    expect(() =>
      computeBalances({
        expenses: [],
        settlements: [
          {
            currency: 'INR',
            fromMemberId: 'a',
            toMemberId: 'a',
            amountMinor: 1,
            status: 'confirmed',
          },
        ],
      }),
    ).toThrow(LedgerError);
    expect(() =>
      computeBalances({
        expenses: [],
        settlements: [
          {
            currency: 'INR',
            fromMemberId: 'a',
            toMemberId: 'b',
            amountMinor: 1.5,
            status: 'confirmed',
          },
        ],
      }),
    ).toThrow(LedgerError);
  });
});

describe('pairwiseDebts', () => {
  it('lists each debtor owing the payer', () => {
    expect(pairwiseDebts({ expenses: [dinner], settlements: [] })).toEqual([
      { fromMemberId: 'b', toMemberId: 'a', currency: 'INR', amountMinor: 3333 },
      { fromMemberId: 'c', toMemberId: 'a', currency: 'INR', amountMinor: 3333 },
    ]);
  });

  it('nets debts in both directions and applies settlements', () => {
    const lunch = {
      currency: 'INR',
      payers: [{ memberId: 'b', paidMinor: 2000 }],
      splits: [
        { memberId: 'a', owedMinor: 1000 },
        { memberId: 'b', owedMinor: 1000 },
      ],
    };
    expect(
      pairwiseDebts({
        expenses: [dinner, lunch],
        settlements: [
          {
            currency: 'INR',
            fromMemberId: 'c',
            toMemberId: 'a',
            amountMinor: 3333,
            status: 'confirmed',
          },
        ],
      }),
    ).toEqual([{ fromMemberId: 'b', toMemberId: 'a', currency: 'INR', amountMinor: 2333 }]);
  });

  it('splits a debt across several payers in proportion to what each overpaid', () => {
    const ledger: Ledger = {
      expenses: [
        {
          currency: 'INR',
          payers: [
            { memberId: 'a', paidMinor: 6000 },
            { memberId: 'd', paidMinor: 4000 },
          ],
          splits: [
            { memberId: 'a', owedMinor: 5000 },
            { memberId: 'b', owedMinor: 5000 },
          ],
        },
      ],
      settlements: [],
    };
    // a overpaid 1000, d overpaid 4000: b's 5000 goes 1000 to a, 4000 to d
    expect(pairwiseDebts(ledger)).toEqual([
      { fromMemberId: 'b', toMemberId: 'a', currency: 'INR', amountMinor: 1000 },
      { fromMemberId: 'b', toMemberId: 'd', currency: 'INR', amountMinor: 4000 },
    ]);
  });
});

describe('simplifyDebts', () => {
  const plan = (nets: Record<string, number>, exact = true) =>
    simplifyDebts(
      Object.entries(nets).map(([memberId, netMinor]) => ({ memberId, currency: 'INR', netMinor })),
      { exact },
    ).map((t) => `${t.fromMemberId}->${t.toMemberId}:${t.amountMinor}`);

  it('settles a simple dinner in two payments', () => {
    expect(plan({ a: 6666, b: -3333, c: -3333 })).toEqual(['b->a:3333', 'c->a:3333']);
  });

  it('collapses a chain a -> b -> c into one payment', () => {
    // a owes b 500, b owes c 500 => a pays c directly
    expect(plan({ a: -500, b: 0, c: 500 })).toEqual(['a->c:500']);
  });

  it('finds independent pairs that greedy misses', () => {
    // greedy pairs the biggest amounts first and needs 4 transfers; two zero-sum pairs need 3
    // (a,b,c,d sum to zero together; {a,e} sums to zero on its own)
    const nets = { a: -700, b: 400, c: 300, d: -600, e: 600 };
    expect(plan(nets, false)).toHaveLength(4);
    expect(plan(nets, true)).toHaveLength(3);
  });

  it('plans each currency separately', () => {
    const transfers = simplifyDebts([
      { memberId: 'a', currency: 'USD', netMinor: 1500 },
      { memberId: 'b', currency: 'USD', netMinor: -1500 },
      { memberId: 'a', currency: 'INR', netMinor: -100 },
      { memberId: 'b', currency: 'INR', netMinor: 100 },
    ]);
    expect(transfers).toEqual([
      { fromMemberId: 'a', toMemberId: 'b', currency: 'INR', amountMinor: 100 },
      { fromMemberId: 'b', toMemberId: 'a', currency: 'USD', amountMinor: 1500 },
    ]);
  });

  it('refuses balances that do not sum to zero', () => {
    expect(() => plan({ a: 100, b: -99 })).toThrow(LedgerError);
  });

  it('returns nothing when everyone is settled', () => {
    expect(plan({ a: 0, b: 0 })).toEqual([]);
  });
});

describe('properties', () => {
  const members = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const currency = fc.constantFrom('INR', 'USD', 'JPY');
  const expense = fc
    .record({
      currency,
      total: fc.integer({ min: 1, max: 10_000_000 }),
      payers: fc.subarray(members, { minLength: 1 }),
      participants: fc.subarray(members, { minLength: 1 }),
    })
    .map(({ currency, total, payers, participants }) => ({
      currency,
      payers: computeSplit(total, { type: 'equal', members: payers }).map((s) => ({
        memberId: s.memberId,
        paidMinor: s.owedMinor,
      })),
      splits: computeSplit(total, { type: 'equal', members: participants }).map((s) => ({
        memberId: s.memberId,
        owedMinor: s.owedMinor,
      })),
    }));
  const settlement = fc
    .record({
      currency,
      from: fc.constantFrom(...members),
      to: fc.constantFrom(...members),
      amountMinor: fc.integer({ min: 1, max: 1_000_000 }),
      status: fc.constantFrom('pending', 'confirmed', 'disputed', 'cancelled' as const),
    })
    .filter((s) => s.from !== s.to)
    .map((s) => ({
      currency: s.currency,
      fromMemberId: s.from,
      toMemberId: s.to,
      amountMinor: s.amountMinor,
      status: s.status,
    }));
  const ledger = fc.record({
    expenses: fc.array(expense, { maxLength: 15 }),
    settlements: fc.array(settlement, { maxLength: 10 }),
  });

  /** Applies transfers to balances; returns the leftover net per currency/member. */
  const leftover = (l: Ledger, transfers: ReturnType<typeof simplifyDebts>) => {
    const nets = new Map(
      computeBalances(l).map((b) => [`${b.currency}/${b.memberId}`, b.netMinor]),
    );
    for (const t of transfers) {
      nets.set(
        `${t.currency}/${t.fromMemberId}`,
        (nets.get(`${t.currency}/${t.fromMemberId}`) ?? 0) + t.amountMinor,
      );
      nets.set(
        `${t.currency}/${t.toMemberId}`,
        (nets.get(`${t.currency}/${t.toMemberId}`) ?? 0) - t.amountMinor,
      );
    }
    return [...nets.values()].filter((v) => v !== 0);
  };

  it('balances sum to zero in every currency', () => {
    fc.assert(
      fc.property(ledger, (l) => {
        const sums = new Map<string, number>();
        for (const b of computeBalances(l))
          sums.set(b.currency, (sums.get(b.currency) ?? 0) + b.netMinor);
        for (const sum of sums.values()) expect(sum).toBe(0);
      }),
    );
  });

  it('simplified transfers settle everyone, in at most n - 1 positive payments per currency', () => {
    fc.assert(
      fc.property(ledger, fc.boolean(), (l, exact) => {
        const balances = computeBalances(l);
        const transfers = simplifyDebts(balances, { exact });
        expect(leftover(l, transfers)).toEqual([]);
        for (const t of transfers) {
          expect(t.amountMinor).toBeGreaterThan(0);
          expect(t.fromMemberId).not.toBe(t.toMemberId);
        }
        const currencies = new Set(balances.map((b) => b.currency));
        for (const c of currencies) {
          const owing = balances.filter((b) => b.currency === c && b.netMinor !== 0).length;
          expect(transfers.filter((t) => t.currency === c).length).toBeLessThanOrEqual(
            Math.max(0, owing - 1),
          );
        }
      }),
    );
  });

  it('the exact plan never needs more payments than the greedy one', () => {
    fc.assert(
      fc.property(ledger, (l) => {
        const balances = computeBalances(l);
        expect(simplifyDebts(balances, { exact: true }).length).toBeLessThanOrEqual(
          simplifyDebts(balances, { exact: false }).length,
        );
      }),
    );
  });

  it('pairwise debts also settle everyone exactly', () => {
    fc.assert(
      fc.property(ledger, (l) => {
        expect(leftover(l, pairwiseDebts(l))).toEqual([]);
      }),
    );
  });

  it('is deterministic regardless of the order balances are given in', () => {
    fc.assert(
      fc.property(ledger, (l) => {
        const balances = computeBalances(l);
        expect(simplifyDebts([...balances].reverse())).toEqual(simplifyDebts(balances));
      }),
    );
  });
});

describe('pairwiseDebts rounding', () => {
  it('never lets two debtors round their leftover unit to the same creditor', () => {
    // found by the property test: g and h each overpaid 1, c and d each owe 1
    const ledger: Ledger = {
      expenses: [
        {
          currency: 'INR',
          payers: [
            { memberId: 'g', paidMinor: 1 },
            { memberId: 'h', paidMinor: 1 },
          ],
          splits: [
            { memberId: 'c', owedMinor: 1 },
            { memberId: 'd', owedMinor: 1 },
            { memberId: 'h', owedMinor: 0 },
          ],
        },
      ],
      settlements: [],
    };
    expect(pairwiseDebts(ledger)).toEqual([
      { fromMemberId: 'c', toMemberId: 'g', currency: 'INR', amountMinor: 1 },
      { fromMemberId: 'd', toMemberId: 'h', currency: 'INR', amountMinor: 1 },
    ]);
  });
});
