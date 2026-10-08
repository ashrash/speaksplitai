import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type {
  PayLinkResponse,
  RecordSettlementRequest,
  SettlementListResponse,
  SettlementView,
} from '@speaksplit/api-types';
import { upiPayUri } from '@speaksplit/split-engine';
import { DataSource, type EntityManager } from 'typeorm';
import { Group, type GroupMember, type User } from '../database/entities/index.js';
import { loadLedger, loadMembers, settlePlan } from './ledger.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class SettlementsService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /**
   * Records a payment. It counts at once, and must clear the full amount the payer owes the
   * payee in that currency according to the group's current plan (simplified or direct).
   * The group row is locked while checking, so two recordings of the same debt can't both win.
   */
  async record(
    groupId: string,
    me: GroupMember,
    user: User,
    input: RecordSettlementRequest,
    requestId: string,
  ) {
    const id = await this.db.transaction(async (tx) => {
      await tx.query('select 1 from groups where id = $1 for update', [groupId]);
      const group = await tx.getRepository(Group).findOneByOrFail({ id: groupId });
      if (input.fromMemberId === input.toMemberId) {
        throw invalid('same_member', 'Payer and payee must be different people');
      }
      if (me.id !== input.fromMemberId && me.id !== input.toMemberId) {
        throw new ForbiddenException({
          code: 'not_a_party',
          message: 'Only the payer or the payee can record a payment',
        });
      }
      const members = await loadMembers(tx, groupId);
      for (const id of [input.fromMemberId, input.toMemberId]) {
        const m = members.get(id);
        if (!m) throw invalid('unknown_member', 'Both people must be members of this group');
        if (m.leftAt) throw invalid('former_member', 'Someone in this payment has left the group');
      }
      if (input.method === 'upi' && (input.paidCurrency ?? input.currency) !== 'INR') {
        throw invalid('upi_inr_only', 'UPI payments are in rupees; record what was sent in INR');
      }

      const owed = settlePlan(await loadLedger(tx, groupId), group.simplifyDebts).find(
        (t) =>
          t.fromMemberId === input.fromMemberId &&
          t.toMemberId === input.toMemberId &&
          t.currency === input.currency,
      );
      if (!owed) {
        throw new ConflictException({
          code: 'nothing_owed',
          message: `According to the group's plan, this person doesn't owe the other anything in ${input.currency}`,
        });
      }
      if (owed.amountMinor !== input.amountMinor) {
        throw new UnprocessableEntityException({
          code: 'partial_payment',
          message: 'A payment must clear the full amount owed',
          details: { expectedMinor: owed.amountMinor, currency: input.currency },
        });
      }

      const [row] = await tx.query<Array<{ id: string }>>(
        `insert into settlements (group_id, from_member_id, to_member_id, amount_minor, currency,
                                  paid_amount_minor, paid_currency, method, upi_ref, note, status,
                                  created_by, confirmed_by, confirmed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'confirmed', $11, $11, now())
         returning id`,
        [
          groupId,
          input.fromMemberId,
          input.toMemberId,
          input.amountMinor,
          input.currency,
          input.paidAmountMinor ?? null,
          input.paidCurrency ?? null,
          input.method,
          input.upiRef ?? null,
          input.note || null,
          user.id,
        ],
      );
      await audit(tx, groupId, row!.id, user.id, 'create', requestId, {
        amountMinor: input.amountMinor,
        currency: input.currency,
        method: input.method,
      });
      return row!.id;
    });
    return this.one(groupId, id);
  }

  /** Undo a recorded payment (payer or payee), unless someone in it has left the group. */
  async cancel(
    groupId: string,
    settlementId: string,
    me: GroupMember,
    user: User,
    requestId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [s] = UUID.test(settlementId)
        ? await tx.query<
            Array<{ id: string; from_member_id: string; to_member_id: string; status: string }>
          >(
            'select id, from_member_id, to_member_id, status from settlements where id = $1 and group_id = $2 for update',
            [settlementId, groupId],
          )
        : [];
      if (!s) throw new NotFoundException('Payment not found');
      if (me.id !== s.from_member_id && me.id !== s.to_member_id) {
        throw new ForbiddenException({
          code: 'not_a_party',
          message: 'Only the payer or the payee can cancel a payment',
        });
      }
      if (s.status === 'cancelled') return;
      const [left] = await tx.query<unknown[]>(
        'select 1 from group_members where id = any($1::uuid[]) and left_at is not null',
        [[s.from_member_id, s.to_member_id]],
      );
      if (left) {
        throw new ConflictException({
          code: 'former_member',
          message: 'This would change the balance of someone who has left the group',
        });
      }
      await tx.query(
        `update settlements set status = 'cancelled', confirmed_at = null, version = version + 1 where id = $1`,
        [s.id],
      );
      await audit(tx, groupId, s.id, user.id, 'cancel', requestId);
    });
  }

  async list(
    groupId: string,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<SettlementListResponse> {
    const params: unknown[] = [groupId, query.limit + 1];
    let where = 's.group_id = $1';
    if (query.cursor) {
      const [createdAt, id] = decodeCursor(query.cursor);
      params.push(createdAt, id);
      where += ' and (s.created_at, s.id) < ($3::timestamptz, $4::uuid)';
    }
    const rows = await this.rows(
      this.db.manager,
      where,
      params,
      'order by s.created_at desc, s.id desc limit $2',
    );
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toView),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor(last.created_at_text, last.id) : null,
    };
  }

  /** The payee's UPI ID and a ready upi://pay link for the amount (null without a UPI ID). */
  async payLink(
    groupId: string,
    toMemberId: string,
    amountMinor: number,
  ): Promise<PayLinkResponse> {
    const [payee] = await this.db.query<
      Array<{
        id: string;
        name: string;
        vpa: string | null;
        left_at: Date | null;
        group_name: string;
        group_type: string;
      }>
    >(
      `select m.id, coalesce(u.name, m.placeholder_name) as name, m.left_at,
              (select vpa from user_upi_ids where user_id = m.user_id and is_primary) as vpa,
              g.name as group_name, g.type as group_type
       from group_members m
       join groups g on g.id = m.group_id
       left join users u on u.id = m.user_id
       where m.id = $1 and m.group_id = $2`,
      [toMemberId, groupId],
    );
    if (!payee) throw new NotFoundException('Member not found');
    const ref = `SS${randomBytes(8).toString('hex').toUpperCase()}`;
    const note = payee.group_type === 'direct' ? 'SpeakSplit' : `SpeakSplit: ${payee.group_name}`;
    return {
      payee: { memberId: payee.id, name: payee.name },
      vpa: payee.vpa,
      uri: payee.vpa
        ? upiPayUri({ vpa: payee.vpa, name: payee.name, amountMinor, note, ref })
        : null,
      ref,
    };
  }

  private async one(groupId: string, id: string): Promise<SettlementView> {
    const [row] = await this.rows(
      this.db.manager,
      's.group_id = $1 and s.id = $2',
      [groupId, id],
      '',
    );
    return toView(row!);
  }

  private rows(manager: EntityManager, where: string, params: unknown[], tail: string) {
    return manager.query<SettlementRow[]>(
      `select s.*, to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_text,
              coalesce(fu.name, fm.placeholder_name) as from_name,
              coalesce(tu.name, tm.placeholder_name) as to_name,
              cu.name as created_by_name
       from settlements s
       join group_members fm on fm.id = s.from_member_id left join users fu on fu.id = fm.user_id
       join group_members tm on tm.id = s.to_member_id left join users tu on tu.id = tm.user_id
       join users cu on cu.id = s.created_by
       where ${where} ${tail}`,
      params,
    );
  }
}

interface SettlementRow {
  id: string;
  from_member_id: string;
  to_member_id: string;
  from_name: string;
  to_name: string;
  currency: string;
  amount_minor: string;
  paid_currency: string | null;
  paid_amount_minor: string | null;
  method: SettlementView['method'];
  upi_ref: string | null;
  note: string | null;
  status: SettlementView['status'];
  created_by: string;
  created_by_name: string;
  created_at_text: string;
}

function toView(r: SettlementRow): SettlementView {
  return {
    id: r.id,
    from: { memberId: r.from_member_id, name: r.from_name },
    to: { memberId: r.to_member_id, name: r.to_name },
    currency: r.currency as SettlementView['currency'],
    amountMinor: Number(r.amount_minor),
    paidCurrency: (r.paid_currency as SettlementView['paidCurrency']) ?? null,
    paidAmountMinor: r.paid_amount_minor === null ? null : Number(r.paid_amount_minor),
    method: r.method,
    upiRef: r.upi_ref,
    note: r.note,
    status: r.status,
    createdBy: { userId: r.created_by, name: r.created_by_name },
    createdAt: r.created_at_text,
  };
}

function invalid(code: string, message: string) {
  return new UnprocessableEntityException({ code, message });
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');
}

function decodeCursor(raw: string): [string, string] {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(raw, 'base64url').toString()) as string[];
    if (
      typeof createdAt === 'string' &&
      !Number.isNaN(Date.parse(createdAt)) &&
      typeof id === 'string' &&
      UUID.test(id)
    ) {
      return [createdAt, id];
    }
  } catch {
    // fall through
  }
  throw new BadRequestException({ code: 'invalid_cursor', message: 'Invalid cursor' });
}

async function audit(
  tx: EntityManager,
  groupId: string,
  settlementId: string,
  actorId: string,
  action: 'create' | 'cancel',
  requestId: string,
  diff?: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `insert into audit_log (group_id, entity, entity_id, actor_id, action, diff, request_id)
     values ($1, 'settlement', $2, $3, $4, $5, $6)`,
    [groupId, settlementId, actorId, action, diff ? JSON.stringify(diff) : null, requestId],
  );
}
