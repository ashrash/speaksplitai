import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { GroupBalancesResponse, MyBalancesResponse } from '@speaksplit/api-types';
import { computeBalances } from '@speaksplit/split-engine';
import { DataSource } from 'typeorm';
import { Group, type User } from '../database/entities/index.js';
import { loadLedger, loadMembers, settlePlan } from './ledger.js';

type Currency = GroupBalancesResponse['plan'][number]['currency'];

@Injectable()
export class BalancesService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** Who is owed and who owes in each currency, and the payments that settle it all. */
  async forGroup(groupId: string): Promise<GroupBalancesResponse> {
    return this.db.transaction('REPEATABLE READ', async (tx) => {
      const group = await tx.getRepository(Group).findOneByOrFail({ id: groupId });
      const ledger = await loadLedger(tx, groupId);
      const members = await loadMembers(tx, groupId);
      const nets = new Map<string, GroupBalancesResponse['members'][number]['balances']>();
      for (const b of computeBalances(ledger)) {
        if (b.netMinor === 0) continue;
        const list = nets.get(b.memberId) ?? [];
        list.push({ currency: b.currency as Currency, netMinor: b.netMinor });
        nets.set(b.memberId, list);
      }
      const ref = (memberId: string) => ({
        memberId,
        name: members.get(memberId)?.name ?? 'Unknown',
      });
      return {
        members: [...members.values()]
          .filter((m) => nets.has(m.memberId))
          .map((m) => ({
            memberId: m.memberId,
            name: m.name,
            userId: m.userId,
            leftAt: m.leftAt?.toISOString() ?? null,
            balances: nets.get(m.memberId)!,
          })),
        plan: settlePlan(ledger, group.simplifyDebts).map((t) => ({
          from: ref(t.fromMemberId),
          to: ref(t.toMemberId),
          currency: t.currency as Currency,
          amountMinor: t.amountMinor,
        })),
        simplified: group.simplifyDebts,
      };
    });
  }

  /** The caller's position across every group, from the member_balances view. */
  async forUser(user: User): Promise<MyBalancesResponse> {
    const rows = await this.db.query<
      Array<{
        group_id: string;
        name: string;
        type: string;
        currency: string;
        net_minor: string;
        friend_id: string | null;
        friend_name: string | null;
      }>
    >(
      `select g.id as group_id, g.name, g.type, mb.currency, mb.net_minor,
              f.id as friend_id, f.name as friend_name
       from member_balances mb
       join groups g on g.id = mb.group_id
       left join group_members other
         on g.type = 'direct' and other.group_id = g.id and other.user_id is distinct from $1
       left join users f on f.id = other.user_id
       where mb.user_id = $1 and mb.net_minor <> 0
       order by g.name, g.id, mb.currency`,
      [user.id],
    );
    const totals = new Map<string, { owed: number; owe: number }>();
    const groups = new Map<string, MyBalancesResponse['groups'][number]>();
    for (const r of rows) {
      const net = Number(r.net_minor);
      const t = totals.get(r.currency) ?? { owed: 0, owe: 0 };
      if (net > 0) t.owed += net;
      else t.owe -= net;
      totals.set(r.currency, t);
      let g = groups.get(r.group_id);
      if (!g) {
        g = {
          groupId: r.group_id,
          name: r.name,
          type: r.type,
          friend: r.friend_id ? { userId: r.friend_id, name: r.friend_name ?? '' } : null,
          balances: [],
        };
        groups.set(r.group_id, g);
      }
      g.balances.push({ currency: r.currency as Currency, netMinor: net });
    }
    return {
      totals: [...totals.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([currency, t]) => ({
          currency: currency as Currency,
          owedToMeMinor: t.owed,
          iOweMinor: t.owe,
          netMinor: t.owed - t.owe,
        })),
      groups: [...groups.values()],
    };
  }
}
