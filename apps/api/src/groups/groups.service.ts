import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type {
  CreateGroupRequest,
  DirectGroupResponse,
  GroupDetailResponse,
  GroupResponse,
  UpdateGroupRequest,
} from '@speaksplit/api-types';
import { DataSource, IsNull } from 'typeorm';
import { AuditLog, Group, GroupMember, User } from '../database/entities/index.js';

type Created = Required<CreateGroupRequest>;
type Update = UpdateGroupRequest;

@Injectable()
export class GroupsService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** Creates the group with the caller as owner, and records it in the audit log. */
  async create(user: User, input: Created, requestId: string): Promise<GroupResponse> {
    return this.db.transaction(async (tx) => {
      const group = await tx.getRepository(Group).save(
        tx.getRepository(Group).create({
          name: input.name,
          type: input.type,
          defaultCurrency: input.defaultCurrency,
          simplifyDebts: input.simplifyDebts,
          createdBy: user.id,
        }),
      );
      const member = await tx.getRepository(GroupMember).save(
        tx.getRepository(GroupMember).create({
          groupId: group.id,
          userId: user.id,
          role: 'owner',
          notifyLevel: 'all',
          joinedAt: new Date(),
        }),
      );
      await tx.getRepository(AuditLog).insert({
        groupId: group.id,
        entity: 'group',
        entityId: group.id,
        actorId: user.id,
        action: 'create',
        diff: { type: group.type, defaultCurrency: group.defaultCurrency },
        requestId,
      });
      return toResponse(group, member);
    });
  }

  /** Groups the user belongs to now (former groups are still readable by id). */
  async listMine(user: User, status: 'active' | 'archived' = 'active'): Promise<GroupResponse[]> {
    const memberships = await this.db
      .getRepository(GroupMember)
      .findBy({ userId: user.id, leftAt: IsNull() });
    if (memberships.length === 0) return [];
    const groups = await this.db
      .getRepository(Group)
      .createQueryBuilder('g')
      .where('g.id in (:...ids)', { ids: memberships.map((m) => m.groupId) })
      .andWhere(status === 'active' ? 'g.archived_at is null' : 'g.archived_at is not null')
      .andWhere(`g.type <> 'direct'`)
      .orderBy('g.created_at', 'DESC')
      .getMany();
    const byGroup = new Map(memberships.map((m) => [m.groupId, m]));
    return groups.map((g) => toResponse(g, byGroup.get(g.id)!));
  }

  async detail(groupId: string, me: GroupMember): Promise<GroupDetailResponse> {
    const group = await this.db.getRepository(Group).findOneByOrFail({ id: groupId });
    const rows = await this.db
      .getRepository(GroupMember)
      .createQueryBuilder('m')
      .leftJoin(User, 'u', 'u.id = m.user_id')
      .select([
        'm.id as id',
        'm.user_id as "userId"',
        'coalesce(u.name, m.placeholder_name) as name',
        'm.role as role',
        'm.joined_at as "joinedAt"',
        'm.left_at as "leftAt"',
      ])
      .where('m.group_id = :groupId', { groupId })
      .orderBy('m.joined_at', 'ASC')
      .addOrderBy('m.id', 'ASC')
      .getRawMany<{
        id: string;
        userId: string | null;
        name: string;
        role: 'owner' | 'admin' | 'member';
        joinedAt: Date;
        leftAt: Date | null;
      }>();
    return {
      ...toResponse(group, me),
      members: rows.map((r) => ({
        ...r,
        joinedAt: r.joinedAt.toISOString(),
        leftAt: r.leftAt?.toISOString() ?? null,
      })),
    };
  }

  /** Optimistic update: fails with 409 if `version` is not the current one. */
  async update(
    groupId: string,
    me: GroupMember,
    user: User,
    input: Update,
    requestId: string,
  ): Promise<GroupResponse> {
    return this.db.transaction(async (tx) => {
      const changes: Partial<Group> = {};
      if (input.name !== undefined) changes.name = input.name;
      if (input.defaultCurrency !== undefined) changes.defaultCurrency = input.defaultCurrency;
      if (input.simplifyDebts !== undefined) changes.simplifyDebts = input.simplifyDebts;

      const result = await tx
        .getRepository(Group)
        .createQueryBuilder()
        .update()
        .set({ ...changes, version: () => 'version + 1' })
        .where('id = :groupId and version = :version', { groupId, version: input.version })
        .execute();
      if (result.affected === 0) {
        throw new StaleVersionError();
      }
      await tx.getRepository(AuditLog).insert({
        groupId,
        entity: 'group',
        entityId: groupId,
        actorId: user.id,
        action: 'update',
        diff: { fields: Object.keys(changes), fromVersion: input.version },
        requestId,
      });
      const group = await tx.getRepository(Group).findOneByOrFail({ id: groupId });
      return toResponse(group, me);
    });
  }
  /** Archives (read-only, hidden from the list) or restores a group. */
  async setArchived(
    groupId: string,
    me: GroupMember,
    user: User,
    archived: boolean,
    requestId: string,
  ): Promise<GroupResponse> {
    return this.db.transaction(async (tx) => {
      const repo = tx.getRepository(Group);
      await repo
        .createQueryBuilder()
        .update()
        .set({ archivedAt: archived ? () => 'now()' : null, version: () => 'version + 1' })
        .where('id = :groupId', { groupId })
        .andWhere(archived ? 'archived_at is null' : 'archived_at is not null')
        .execute();
      await tx.getRepository(AuditLog).insert({
        groupId,
        entity: 'group',
        entityId: groupId,
        actorId: user.id,
        action: 'update',
        diff: { archived },
        requestId,
      });
      return toResponse(await repo.findOneByOrFail({ id: groupId }), me);
    });
  }

  /**
   * Deletes a group and everything in it, only when every member's balance is zero in every
   * currency. The group row is locked first, so no expense or payment can be added between the
   * check and the delete. The audit log keeps the record (it has no foreign keys).
   */
  async remove(groupId: string, user: User, requestId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('select 1 from groups where id = $1 for update', [groupId]);
      const unsettled = await tx.query<Array<{ currency: string; members: number }>>(
        `select currency, count(*)::int as members
         from member_balances
         where group_id = $1 and net_minor <> 0
         group by currency
         order by currency`,
        [groupId],
      );
      if (unsettled.length > 0) {
        throw new ConflictException({
          code: 'unsettled',
          message: 'Settle up first: some balances in this group are not zero',
          details: unsettled,
        });
      }
      await tx.getRepository(Group).delete({ id: groupId });
      await tx.getRepository(AuditLog).insert({
        groupId,
        entity: 'group',
        entityId: groupId,
        actorId: user.id,
        action: 'delete',
        requestId,
      });
    });
  }

  /**
   * Returns the friend-to-friend group with another user, creating it the first time. There is
   * one per pair (groups.direct_key is unique); two people opening it at once get the same group.
   * Allowed only with a friend or someone you share (or shared) a group with, and never if
   * either has blocked the other.
   */
  async openDirect(user: User, friendId: string, requestId: string): Promise<DirectGroupResponse> {
    if (friendId === user.id) {
      throw new BadRequestException({ code: 'self', message: "You can't split with yourself" });
    }
    const friend = await this.db.getRepository(User).findOneBy({ id: friendId });
    const known =
      friend &&
      !friend.deletedAt &&
      (
        await this.db.query<unknown[]>(
          `select 1
           from group_members a
           join group_members b on b.group_id = a.group_id
           join groups g on g.id = a.group_id
           where a.user_id = $1 and b.user_id = $2 and g.type <> 'direct'
           union all
           select 1 from friendships
           where user_a = least($1::uuid, $2::uuid) and user_b = greatest($1::uuid, $2::uuid)
           limit 1`,
          [user.id, friendId],
        )
      ).length > 0;
    if (!friend || !known) {
      throw new NotFoundException('Person not found');
    }
    const blocked = await this.db.query<unknown[]>(
      `select 1 from blocks
       where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)`,
      [user.id, friendId],
    );
    if (blocked.length > 0) {
      throw new ForbiddenException({
        code: 'blocked',
        message: "You can't split with this person",
      });
    }

    const directKey = [user.id, friendId].sort().join(':');
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .getRepository(Group)
        .createQueryBuilder()
        .insert()
        .values({
          name: 'Direct',
          type: 'direct',
          defaultCurrency: user.defaultCurrency,
          simplifyDebts: true,
          directKey,
          createdBy: user.id,
        })
        .orIgnore() // someone opened it at the same moment: use theirs
        .returning(['id'])
        .execute();
      const group = await tx.getRepository(Group).findOneByOrFail({ directKey });
      if (inserted.raw.length > 0) {
        const members = tx.getRepository(GroupMember);
        await members.insert([
          {
            groupId: group.id,
            userId: user.id,
            role: 'owner',
            notifyLevel: 'all',
            joinedAt: new Date(),
          },
          {
            groupId: group.id,
            userId: friendId,
            role: 'member',
            notifyLevel: 'all',
            joinedAt: new Date(),
            invitedBy: user.id,
          },
        ]);
        await tx.getRepository(AuditLog).insert({
          groupId: group.id,
          entity: 'group',
          entityId: group.id,
          actorId: user.id,
          action: 'create',
          diff: { type: 'direct' },
          requestId,
        });
      }
      return toDirect(group, friend);
    });
  }

  /** The user's friend-to-friend groups, most recently created first. */
  async listDirect(user: User): Promise<DirectGroupResponse[]> {
    const rows = await this.db.query<
      Array<{
        group_id: string;
        friend_id: string;
        friend_name: string;
        default_currency: string;
        archived_at: Date | null;
      }>
    >(
      `select g.id as group_id, f.id as friend_id, f.name as friend_name,
              g.default_currency, g.archived_at
       from group_members me
       join groups g on g.id = me.group_id and g.type = 'direct'
       join group_members other on other.group_id = g.id and other.user_id <> me.user_id
       join users f on f.id = other.user_id
       where me.user_id = $1
       order by g.created_at desc`,
      [user.id],
    );
    return rows.map((r) => ({
      groupId: r.group_id,
      friend: { userId: r.friend_id, name: r.friend_name },
      defaultCurrency: r.default_currency as DirectGroupResponse['defaultCurrency'],
      archivedAt: r.archived_at?.toISOString() ?? null,
    }));
  }
}

/** Raised when an optimistic update lost the race; mapped to 409 by the controller. */
export class StaleVersionError extends Error {
  override name = 'StaleVersionError';
}

function toDirect(group: Group, friend: User): DirectGroupResponse {
  return {
    groupId: group.id,
    friend: { userId: friend.id, name: friend.name },
    defaultCurrency: group.defaultCurrency as DirectGroupResponse['defaultCurrency'],
    archivedAt: group.archivedAt?.toISOString() ?? null,
  };
}

function toResponse(group: Group, me: GroupMember): GroupResponse {
  return {
    id: group.id,
    name: group.name,
    type: group.type,
    defaultCurrency: group.defaultCurrency as GroupResponse['defaultCurrency'],
    simplifyDebts: group.simplifyDebts,
    version: group.version,
    archivedAt: group.archivedAt?.toISOString() ?? null,
    me: { memberId: me.id, role: me.role, leftAt: me.leftAt?.toISOString() ?? null },
  };
}
