import type { EntityManager } from 'typeorm';

/** Currencies in which a member's balance is not zero (from the member_balances view). */
export async function unsettledCurrencies(
  tx: EntityManager,
  groupId: string,
  memberId: string,
): Promise<Array<{ currency: string; netMinor: number }>> {
  const rows = await tx.query<Array<{ currency: string; net_minor: string }>>(
    `select currency, net_minor from member_balances
     where group_id = $1 and member_id = $2 and net_minor <> 0
     order by currency`,
    [groupId, memberId],
  );
  return rows.map((r) => ({ currency: r.currency, netMinor: Number(r.net_minor) }));
}
