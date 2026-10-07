import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type {
  ExpenseDetail,
  ExpenseListResponse,
  ExpenseRequest,
  ExpenseSplitInput,
  UpdateExpenseRequest,
} from '@speaksplit/api-types';
import { computeSplit, SplitError, type SplitInput } from '@speaksplit/split-engine';
import { DataSource, type EntityManager } from 'typeorm';
import {
  Expense,
  ExpensePayer,
  ExpenseSplit,
  Group,
  GroupMember,
  type User,
} from '../database/entities/index.js';

type Input = Omit<ExpenseRequest, 'source'> & { source: NonNullable<ExpenseRequest['source']> };

interface Prepared {
  currency: string;
  payers: Array<{ memberId: string; paidMinor: number }>;
  splits: Array<{
    memberId: string;
    owedMinor: number;
    shareValue: string | null;
    adjustmentMinor: number | null;
  }>;
}

/** member id -> [paid, owed] for one expense. */
type Amounts = Map<string, [number, number]>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ExpensesService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** Creates an expense with its payers and splits in one transaction (totals checked at commit). */
  async create(
    groupId: string,
    user: User,
    input: Input,
    requestId: string,
  ): Promise<ExpenseDetail> {
    const id = await this.db.transaction(async (tx) => {
      const group = await tx.getRepository(Group).findOneByOrFail({ id: groupId });
      const prepared = await this.prepare(
        tx,
        groupId,
        input,
        input.currency ?? group.defaultCurrency,
        new Map(),
      );
      const expense = await tx.getRepository(Expense).save(
        tx.getRepository(Expense).create({
          groupId,
          description: input.description,
          category: input.category ?? null,
          notes: input.notes ?? null,
          totalMinor: input.totalMinor,
          currency: prepared.currency,
          expenseDate: input.expenseDate,
          splitType: input.split.type,
          source: input.source,
          createdBy: user.id,
        }),
      );
      await this.writeRows(tx, groupId, expense.id, prepared);
      await audit(tx, groupId, expense.id, user.id, 'create', requestId, {
        totalMinor: input.totalMinor,
        currency: prepared.currency,
        splitType: input.split.type,
      });
      return expense.id;
    });
    return this.detail(groupId, id);
  }

  /**
   * Replaces an expense's fields, payers and splits. Optimistic: `version` must be current.
   * Anyone who has left the group must keep exactly the amounts they had.
   */
  async update(
    groupId: string,
    expenseId: string,
    user: User,
    input: Omit<UpdateExpenseRequest, 'source'> & { source: NonNullable<ExpenseRequest['source']> },
    requestId: string,
  ): Promise<ExpenseDetail> {
    await this.db.transaction(async (tx) => {
      const expense = await this.lock(tx, groupId, expenseId);
      if (expense.deletedAt) {
        throw new ConflictException({
          code: 'deleted',
          message: 'This expense was deleted; restore it first',
        });
      }
      if (expense.version !== input.version) throw staleVersion();
      const before = await this.amounts(tx, expenseId);
      const prepared = await this.prepare(
        tx,
        groupId,
        input,
        input.currency ?? expense.currency,
        before,
      );
      await this.requireFormerMembersUnchanged(tx, groupId, before, toAmounts(prepared));

      await tx
        .getRepository(Expense)
        .createQueryBuilder()
        .update()
        .set({
          description: input.description,
          category: input.category ?? null,
          notes: input.notes ?? null,
          totalMinor: input.totalMinor,
          currency: prepared.currency,
          expenseDate: input.expenseDate,
          splitType: input.split.type,
          source: input.source,
          updatedBy: user.id,
          version: () => 'version + 1',
        })
        .where('id = :expenseId', { expenseId })
        .execute();
      await tx.getRepository(ExpensePayer).delete({ expenseId });
      await tx.getRepository(ExpenseSplit).delete({ expenseId });
      await this.writeRows(tx, groupId, expenseId, prepared);
      await audit(tx, groupId, expenseId, user.id, 'update', requestId, {
        fromVersion: input.version,
        before: { totalMinor: expense.totalMinor, currency: expense.currency },
        after: { totalMinor: input.totalMinor, currency: prepared.currency },
      });
    });
    return this.detail(groupId, expenseId);
  }

  /** Soft delete; restorable. Not allowed when it would change a former member's balance. */
  async remove(groupId: string, expenseId: string, user: User, requestId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const expense = await this.lock(tx, groupId, expenseId);
      if (expense.deletedAt) return;
      await this.requireFormerMembersUnchanged(
        tx,
        groupId,
        await this.amounts(tx, expenseId),
        new Map(),
      );
      await tx
        .getRepository(Expense)
        .createQueryBuilder()
        .update()
        .set({ deletedAt: () => 'now()', deletedBy: user.id, version: () => 'version + 1' })
        .where('id = :expenseId', { expenseId })
        .execute();
      await audit(tx, groupId, expenseId, user.id, 'delete', requestId);
    });
  }

  async restore(
    groupId: string,
    expenseId: string,
    user: User,
    requestId: string,
  ): Promise<ExpenseDetail> {
    await this.db.transaction(async (tx) => {
      const expense = await this.lock(tx, groupId, expenseId);
      if (!expense.deletedAt) return;
      await this.requireFormerMembersUnchanged(
        tx,
        groupId,
        new Map(),
        await this.amounts(tx, expenseId),
      );
      await tx
        .getRepository(Expense)
        .createQueryBuilder()
        .update()
        .set({ deletedAt: null, deletedBy: null, updatedBy: user.id, version: () => 'version + 1' })
        .where('id = :expenseId', { expenseId })
        .execute();
      await audit(tx, groupId, expenseId, user.id, 'restore', requestId);
    });
    return this.detail(groupId, expenseId);
  }

  async detail(groupId: string, expenseId: string): Promise<ExpenseDetail> {
    if (!UUID.test(expenseId)) throw new NotFoundException('Expense not found');
    const [e] = await this.db.query<Array<Record<string, unknown>>>(
      `select e.id, e.group_id, e.description, e.category, e.notes, e.total_minor, e.currency,
              to_char(e.expense_date, 'YYYY-MM-DD') as expense_date, e.split_type, e.source, e.version,
              e.created_by, u.name as created_by_name, e.created_at, e.updated_at, e.deleted_at
       from expenses e join users u on u.id = e.created_by
       where e.id = $1 and e.group_id = $2`,
      [expenseId, groupId],
    );
    if (!e) throw new NotFoundException('Expense not found');
    const memberName = `coalesce(u.name, m.placeholder_name)`;
    const payers = await this.db.query<
      Array<{ member_id: string; name: string; paid_minor: string }>
    >(
      `select p.member_id, ${memberName} as name, p.paid_minor
       from expense_payers p join group_members m on m.id = p.member_id left join users u on u.id = m.user_id
       where p.expense_id = $1 order by m.joined_at, m.id`,
      [expenseId],
    );
    const splits = await this.db.query<
      Array<{
        member_id: string;
        name: string;
        owed_minor: string;
        share_value: string | null;
        adjustment_minor: string | null;
      }>
    >(
      `select s.member_id, ${memberName} as name, s.owed_minor, s.share_value::text as share_value, s.adjustment_minor
       from expense_splits s join group_members m on m.id = s.member_id left join users u on u.id = m.user_id
       where s.expense_id = $1 order by m.joined_at, m.id`,
      [expenseId],
    );
    return {
      id: e.id as string,
      groupId: e.group_id as string,
      description: e.description as string,
      category: (e.category as ExpenseDetail['category']) ?? null,
      notes: (e.notes as string | null) ?? null,
      totalMinor: Number(e.total_minor),
      currency: e.currency as ExpenseDetail['currency'],
      expenseDate: e.expense_date as string,
      splitType: e.split_type as ExpenseDetail['splitType'],
      source: e.source as string,
      version: e.version as number,
      createdBy: { userId: e.created_by as string, name: e.created_by_name as string },
      createdAt: (e.created_at as Date).toISOString(),
      updatedAt: (e.updated_at as Date).toISOString(),
      deletedAt: (e.deleted_at as Date | null)?.toISOString() ?? null,
      payers: payers.map((p) => ({
        memberId: p.member_id,
        name: p.name,
        paidMinor: Number(p.paid_minor),
      })),
      splits: splits.map((s) => ({
        memberId: s.member_id,
        name: s.name,
        owedMinor: Number(s.owed_minor),
        shareValue: s.share_value === null ? null : trimDecimal(s.share_value),
        adjustmentMinor: s.adjustment_minor === null ? null : Number(s.adjustment_minor),
      })),
    };
  }

  /**
   * Newest first (by expense date, then creation), keyset-paginated so pages stay stable while
   * people add expenses. Default scope: only expenses the caller paid for or is part of.
   */
  async list(
    groupId: string,
    me: GroupMember,
    query: { scope: 'mine' | 'all'; limit: number; cursor?: string | undefined },
  ): Promise<ExpenseListResponse> {
    const params: unknown[] = [groupId, me.id, query.limit + 1];
    let where = 'e.group_id = $1 and e.deleted_at is null';
    if (query.scope === 'mine') {
      where += ` and (exists (select 1 from expense_payers p where p.expense_id = e.id and p.member_id = $2)
                   or exists (select 1 from expense_splits s where s.expense_id = e.id and s.member_id = $2))`;
    }
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      params.push(c.date, c.createdAt, c.id);
      where += ' and (e.expense_date, e.created_at, e.id) < ($4::date, $5::timestamptz, $6::uuid)';
    }
    const rows = await this.db.query<
      Array<{
        id: string;
        description: string;
        category: string | null;
        total_minor: string;
        currency: string;
        expense_date: string;
        split_type: string;
        created_at: string;
        paid: string;
        owed: string;
      }>
    >(
      `select e.id, e.description, e.category, e.total_minor, e.currency,
              to_char(e.expense_date, 'YYYY-MM-DD') as expense_date, e.split_type,
              to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
              coalesce((select sum(p.paid_minor) from expense_payers p where p.expense_id = e.id and p.member_id = $2), 0) as paid,
              coalesce((select sum(s.owed_minor) from expense_splits s where s.expense_id = e.id and s.member_id = $2), 0) as owed
       from expenses e
       where ${where}
       order by e.expense_date desc, e.created_at desc, e.id desc
       limit $3`,
      params,
    );
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        description: r.description,
        category: (r.category as ExpenseListResponse['items'][number]['category']) ?? null,
        totalMinor: Number(r.total_minor),
        currency: r.currency as ExpenseListResponse['items'][number]['currency'],
        expenseDate: r.expense_date,
        splitType: r.split_type as ExpenseListResponse['items'][number]['splitType'],
        createdAt: r.created_at,
        mine: {
          paidMinor: Number(r.paid),
          owedMinor: Number(r.owed),
          netMinor: Number(r.paid) - Number(r.owed),
        },
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ date: last.expense_date, createdAt: last.created_at, id: last.id })
          : null,
    };
  }

  // ---- helpers ----

  /**
   * Validates members and amounts and runs the split engine. Members must belong to the group
   * and be current, except former members who were already on this expense (`existing`).
   * Splits run in the order members joined, so leftovers land the same way on every device.
   */
  private async prepare(
    tx: EntityManager,
    groupId: string,
    input: Pick<Input, 'totalMinor' | 'payers' | 'split'>,
    currency: string,
    existing: Amounts,
  ): Promise<Prepared> {
    const payerIds = input.payers.map((p) => p.memberId);
    if (new Set(payerIds).size !== payerIds.length) {
      throw invalid('duplicate_payer', 'Each person can appear only once as a payer');
    }
    const paid = input.payers.reduce((sum, p) => sum + BigInt(p.paidMinor), 0n);
    if (paid !== BigInt(input.totalMinor)) {
      throw invalid(
        'payers_total',
        `Payers add up to ${paid}, but the total is ${input.totalMinor}`,
      );
    }

    const splitIds = splitMemberIds(input.split);
    const ids = [...new Set([...payerIds, ...splitIds])];
    const members = await tx
      .getRepository(GroupMember)
      .createQueryBuilder('m')
      .where('m.group_id = :groupId and m.id in (:...ids)', { groupId, ids })
      .orderBy('m.joined_at', 'ASC')
      .addOrderBy('m.id', 'ASC')
      .getMany();
    if (members.length !== ids.length) {
      throw invalid('unknown_member', 'Everyone on an expense must be a member of this group');
    }
    for (const m of members) {
      if (m.leftAt && !existing.has(m.id)) {
        throw invalid('former_member', 'Someone on this expense has left the group');
      }
    }
    const rank = new Map(members.map((m, i) => [m.id, i]));
    const byJoin = <T>(rows: T[], key: (row: T) => string) =>
      [...rows].sort((a, b) => rank.get(key(a))! - rank.get(key(b))!);

    let engineInput: SplitInput;
    switch (input.split.type) {
      case 'equal':
        engineInput = { type: 'equal', members: byJoin(input.split.memberIds, (id) => id) };
        break;
      case 'exact':
        engineInput = { type: 'exact', amounts: byJoin(input.split.amounts, (a) => a.memberId) };
        break;
      case 'percent':
        engineInput = {
          type: 'percent',
          percents: byJoin(input.split.percents, (p) => p.memberId),
        };
        break;
      case 'shares':
        engineInput = { type: 'shares', shares: byJoin(input.split.shares, (s) => s.memberId) };
        break;
      case 'adjustment':
        engineInput = {
          type: 'adjustment',
          adjustments: byJoin(input.split.adjustments, (a) => a.memberId),
        };
        break;
    }
    let owed;
    try {
      owed = computeSplit(input.totalMinor, engineInput);
    } catch (err) {
      if (err instanceof SplitError) throw invalid('invalid_split', err.message);
      throw err;
    }

    const shareValue = new Map<string, string>();
    const adjustment = new Map<string, number>();
    if (input.split.type === 'percent')
      input.split.percents.forEach((p) => shareValue.set(p.memberId, p.percent));
    if (input.split.type === 'shares')
      input.split.shares.forEach((s) => shareValue.set(s.memberId, s.shares));
    if (input.split.type === 'adjustment') {
      input.split.adjustments.forEach((a) => adjustment.set(a.memberId, a.adjustmentMinor));
    }
    return {
      currency,
      payers: byJoin(input.payers, (p) => p.memberId),
      splits: owed.map((s) => ({
        memberId: s.memberId,
        owedMinor: s.owedMinor,
        shareValue: shareValue.get(s.memberId) ?? null,
        adjustmentMinor: adjustment.get(s.memberId) ?? null,
      })),
    };
  }

  private async writeRows(
    tx: EntityManager,
    groupId: string,
    expenseId: string,
    prepared: Prepared,
  ): Promise<void> {
    await tx
      .getRepository(ExpensePayer)
      .insert(prepared.payers.map((p) => ({ ...p, expenseId, groupId })));
    await tx
      .getRepository(ExpenseSplit)
      .insert(prepared.splits.map((s) => ({ ...s, expenseId, groupId })));
  }

  private async lock(tx: EntityManager, groupId: string, expenseId: string): Promise<Expense> {
    const expense = UUID.test(expenseId)
      ? await tx
          .getRepository(Expense)
          .createQueryBuilder('e')
          .setLock('pessimistic_write')
          .where('e.id = :expenseId and e.group_id = :groupId', { expenseId, groupId })
          .getOne()
      : null;
    if (!expense) throw new NotFoundException('Expense not found');
    return expense;
  }

  private async amounts(tx: EntityManager, expenseId: string): Promise<Amounts> {
    const rows = await tx.query<Array<{ member_id: string; paid: string; owed: string }>>(
      `select member_id, sum(paid)::bigint as paid, sum(owed)::bigint as owed from (
         select member_id, paid_minor as paid, 0 as owed from expense_payers where expense_id = $1
         union all
         select member_id, 0, owed_minor from expense_splits where expense_id = $1
       ) x group by member_id`,
      [expenseId],
    );
    return new Map(rows.map((r) => [r.member_id, [Number(r.paid), Number(r.owed)]]));
  }

  /** Former members already settled up; nothing may change what they paid or owe. */
  private async requireFormerMembersUnchanged(
    tx: EntityManager,
    groupId: string,
    before: Amounts,
    after: Amounts,
  ): Promise<void> {
    const ids = [...new Set([...before.keys(), ...after.keys()])];
    if (ids.length === 0) return;
    const former = await tx.query<Array<{ id: string }>>(
      'select id from group_members where group_id = $1 and id = any($2::uuid[]) and left_at is not null',
      [groupId, ids],
    );
    for (const { id } of former) {
      const [p1, o1] = before.get(id) ?? [0, 0];
      const [p2, o2] = after.get(id) ?? [0, 0];
      if (p1 !== p2 || o1 !== o2) {
        throw new ConflictException({
          code: 'former_member',
          message: 'This would change the balance of someone who has left the group',
        });
      }
    }
  }
}

function splitMemberIds(split: ExpenseSplitInput): string[] {
  switch (split.type) {
    case 'equal':
      return split.memberIds;
    case 'exact':
      return split.amounts.map((a) => a.memberId);
    case 'percent':
      return split.percents.map((p) => p.memberId);
    case 'shares':
      return split.shares.map((s) => s.memberId);
    case 'adjustment':
      return split.adjustments.map((a) => a.memberId);
  }
}

function toAmounts(prepared: Prepared): Amounts {
  const map: Amounts = new Map();
  for (const p of prepared.payers)
    map.set(p.memberId, [p.paidMinor, map.get(p.memberId)?.[1] ?? 0]);
  for (const s of prepared.splits)
    map.set(s.memberId, [map.get(s.memberId)?.[0] ?? 0, s.owedMinor]);
  return map;
}

/** numeric(12,4) comes back as "33.3300"; show "33.33". */
function trimDecimal(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

function invalid(code: string, message: string) {
  return new UnprocessableEntityException({ code, message });
}

function staleVersion() {
  return new ConflictException({
    code: 'stale_version',
    message: 'Someone else changed this expense first; reload and try again',
  });
}

interface Cursor {
  date: string;
  createdAt: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.date, c.createdAt, c.id])).toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    const [date, createdAt, id] = JSON.parse(Buffer.from(raw, 'base64url').toString()) as string[];
    if (
      typeof date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      typeof createdAt === 'string' &&
      !Number.isNaN(Date.parse(createdAt)) &&
      typeof id === 'string' &&
      UUID.test(id)
    ) {
      return { date, createdAt, id };
    }
  } catch {
    // fall through
  }
  throw new BadRequestException({ code: 'invalid_cursor', message: 'Invalid cursor' });
}

async function audit(
  tx: EntityManager,
  groupId: string,
  expenseId: string,
  actorId: string,
  action: 'create' | 'update' | 'delete' | 'restore',
  requestId: string,
  diff?: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `insert into audit_log (group_id, entity, entity_id, actor_id, action, diff, request_id)
     values ($1, 'expense', $2, $3, $4, $5, $6)`,
    [groupId, expenseId, actorId, action, diff ? JSON.stringify(diff) : null, requestId],
  );
}
