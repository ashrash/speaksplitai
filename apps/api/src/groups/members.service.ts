import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, IsNull } from 'typeorm';
import type { AuditAction } from '../database/entities/audit-log.entity.js';
import { GroupMember, type User } from '../database/entities/index.js';
import { unsettledCurrencies } from './balances.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class MembersService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** Adds someone by name who hasn't joined yet; they claim it later through an invite. */
  async addPlaceholder(groupId: string, user: User, name: string, requestId: string) {
    return this.db.transaction(async (tx) => {
      const member = await tx.getRepository(GroupMember).save(
        tx.getRepository(GroupMember).create({
          groupId,
          placeholderName: name,
          role: 'member',
          notifyLevel: 'none',
          invitedBy: user.id,
          joinedAt: new Date(),
        }),
      );
      await audit(tx, groupId, member.id, user.id, 'create', requestId, { placeholder: true });
      return { id: member.id, userId: null, name, role: member.role };
    });
  }

  /**
   * Removes a member (or placeholder). Not the owner, and only when their balance is zero in
   * every currency. They keep read-only access to the group's history.
   */
  async remove(groupId: string, memberId: string, user: User, requestId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const target = UUID.test(memberId)
        ? await tx
            .getRepository(GroupMember)
            .createQueryBuilder('m')
            .setLock('pessimistic_write')
            .where('m.id = :memberId and m.group_id = :groupId', { memberId, groupId })
            .getOne()
        : null;
      if (!target) throw new NotFoundException('Member not found');
      if (target.leftAt) return;
      if (target.role === 'owner') {
        throw new ConflictException({
          code: 'owner',
          message: "The group's owner can't be removed",
        });
      }
      await this.requireSettled(tx, groupId, target.id, 'They');
      await tx
        .getRepository(GroupMember)
        .update({ id: target.id }, { leftAt: new Date(), removedBy: user.id });
      await audit(tx, groupId, target.id, user.id, 'remove', requestId);
    });
  }

  /** The caller leaves. Owners can't (there's no ownership transfer yet); balance must be zero. */
  async leave(groupId: string, me: GroupMember, user: User, requestId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (me.role === 'owner') {
        throw new ConflictException({
          code: 'owner',
          message: 'Owners can’t leave their group; archive or delete it instead',
        });
      }
      await tx.query('select 1 from group_members where id = $1 for update', [me.id]);
      await this.requireSettled(tx, groupId, me.id, 'You');
      await tx
        .getRepository(GroupMember)
        .update({ id: me.id, leftAt: IsNull() }, { leftAt: new Date() });
      await audit(tx, groupId, me.id, user.id, 'leave', requestId);
    });
  }

  private async requireSettled(
    tx: EntityManager,
    groupId: string,
    memberId: string,
    who: 'You' | 'They',
  ): Promise<void> {
    const unsettled = await unsettledCurrencies(tx, groupId, memberId);
    if (unsettled.length > 0) {
      throw new ConflictException({
        code: 'unsettled',
        message: `${who} still owe or are owed money in this group; settle up first`,
        details: unsettled,
      });
    }
  }
}

/** Appends a member event to the audit log (which also feeds the activity feed). */
export async function audit(
  tx: EntityManager,
  groupId: string,
  entityId: string,
  actorId: string,
  action: AuditAction,
  requestId: string,
  diff?: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `insert into audit_log (group_id, entity, entity_id, actor_id, action, diff, request_id)
     values ($1, 'member', $2, $3, $4, $5, $6)`,
    [groupId, entityId, actorId, action, diff ? JSON.stringify(diff) : null, requestId],
  );
}
