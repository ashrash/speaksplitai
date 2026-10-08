import {
  computeBalances,
  type Ledger,
  pairwiseDebts,
  simplifyDebts,
  type Transfer,
} from '@speaksplit/split-engine';
import type { EntityManager } from 'typeorm';

export interface MemberInfo {
  memberId: string;
  name: string;
  userId: string | null;
  leftAt: Date | null;
}

/** Everything that moves money in a group: live expenses and all settlements. */
export async function loadLedger(manager: EntityManager, groupId: string): Promise<Ledger> {
  const rows = await manager.query<
    Array<{ expense_id: string; currency: string; member_id: string; paid: string; owed: string }>
  >(
    `select e.id as expense_id, e.currency, x.member_id, x.paid, x.owed
     from expenses e
     join (
       select expense_id, member_id, paid_minor as paid, 0::bigint as owed from expense_payers where group_id = $1
       union all
       select expense_id, member_id, 0::bigint, owed_minor from expense_splits where group_id = $1
     ) x on x.expense_id = e.id
     where e.group_id = $1 and e.deleted_at is null`,
    [groupId],
  );
  const expenses = new Map<string, Ledger['expenses'][number]>();
  for (const r of rows) {
    let e = expenses.get(r.expense_id);
    if (!e) expenses.set(r.expense_id, (e = { currency: r.currency, payers: [], splits: [] }));
    if (Number(r.paid) > 0) e.payers.push({ memberId: r.member_id, paidMinor: Number(r.paid) });
    else e.splits.push({ memberId: r.member_id, owedMinor: Number(r.owed) });
  }
  const settlements = await manager.query<
    Array<{
      currency: string;
      from_member_id: string;
      to_member_id: string;
      amount_minor: string;
      status: string;
    }>
  >(
    'select currency, from_member_id, to_member_id, amount_minor, status from settlements where group_id = $1',
    [groupId],
  );
  return {
    expenses: [...expenses.values()],
    settlements: settlements.map((s) => ({
      currency: s.currency,
      fromMemberId: s.from_member_id,
      toMemberId: s.to_member_id,
      amountMinor: Number(s.amount_minor),
      status: s.status as Ledger['settlements'][number]['status'],
    })),
  };
}

/** The payments that settle the group: simplified, or who owes whom directly. */
export function settlePlan(ledger: Ledger, simplify: boolean): Transfer[] {
  return simplify ? simplifyDebts(computeBalances(ledger)) : pairwiseDebts(ledger);
}

export async function loadMembers(
  manager: EntityManager,
  groupId: string,
): Promise<Map<string, MemberInfo>> {
  const rows = await manager.query<
    Array<{ id: string; name: string; user_id: string | null; left_at: Date | null }>
  >(
    `select m.id, coalesce(u.name, m.placeholder_name) as name, m.user_id, m.left_at
     from group_members m left join users u on u.id = m.user_id
     where m.group_id = $1
     order by m.joined_at, m.id`,
    [groupId],
  );
  return new Map(
    rows.map((r) => [r.id, { memberId: r.id, name: r.name, userId: r.user_id, leftAt: r.left_at }]),
  );
}
