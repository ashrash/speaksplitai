import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type {
  CreateGroupRequest,
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
  async listMine(user: User): Promise<GroupResponse[]> {
    const memberships = await this.db
      .getRepository(GroupMember)
      .findBy({ userId: user.id, leftAt: IsNull() });
    if (memberships.length === 0) return [];
    const groups = await this.db
      .getRepository(Group)
      .createQueryBuilder('g')
      .where('g.id in (:...ids)', { ids: memberships.map((m) => m.groupId) })
      .andWhere('g.archived_at is null')
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
}

/** Raised when an optimistic update lost the race; mapped to 409 by the controller. */
export class StaleVersionError extends Error {
  override name = 'StaleVersionError';
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
