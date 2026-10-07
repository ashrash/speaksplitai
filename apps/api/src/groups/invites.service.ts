import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type {
  AcceptInviteResponse,
  CreateInviteRequest,
  InvitePreview,
  InviteResponse,
} from '@speaksplit/api-types';
import { DataSource, type EntityManager } from 'typeorm';
import { eitherBlocked } from '../common/blocks.js';
import type { Env } from '../config/env.js';
import { Group, GroupMember, Invite, User } from '../database/entities/index.js';
import { areFriends, befriend } from '../friends/friendship.js';
import { audit } from './members.service.js';

/** Enough for any real group; stops a runaway client. */
export const MAX_ACTIVE_INVITES = 20;
/** Personal "add me as a friend" links a user can have active at once. */
export const MAX_ACTIVE_FRIEND_INVITES = 10;

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

@Injectable()
export class InvitesService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Creates an invite link. The raw token is returned once and never stored. */
  async create(
    groupId: string,
    user: User,
    input: Required<Pick<CreateInviteRequest, 'expiresInHours'>> & CreateInviteRequest,
  ): Promise<InviteResponse> {
    return this.db.transaction(async (tx) => {
      await tx.query('select 1 from groups where id = $1 for update', [groupId]);
      const [active] = await tx.query<Array<{ n: number }>>(
        `select count(*)::int as n from invites
         where group_id = $1 and revoked_at is null and expires_at > now()
           and (max_uses is null or use_count < max_uses)`,
        [groupId],
      );
      if ((active?.n ?? 0) >= MAX_ACTIVE_INVITES) {
        throw new ConflictException({
          code: 'limit',
          message: `At most ${MAX_ACTIVE_INVITES} active invites per group; revoke some first`,
        });
      }

      let placeholder: GroupMember | null = null;
      if (input.placeholderMemberId) {
        placeholder = await tx
          .getRepository(GroupMember)
          .findOneBy({ id: input.placeholderMemberId, groupId });
        if (!placeholder || placeholder.userId || placeholder.leftAt) {
          throw new NotFoundException('Placeholder member not found');
        }
      }

      const token = randomBytes(32).toString('base64url');
      const invite = await tx.getRepository(Invite).save(
        tx.getRepository(Invite).create({
          kind: 'group',
          groupId,
          tokenHash: hashToken(token),
          placeholderMemberId: placeholder?.id ?? null,
          createdBy: user.id,
          maxUses: placeholder ? 1 : (input.maxUses ?? null),
          useCount: 0,
          expiresAt: new Date(Date.now() + input.expiresInHours * 3_600_000),
        }),
      );
      return { ...toResponse(invite, user.name, placeholder), ...this.link(token) };
    });
  }

  /** A personal "add me as a friend" link: whoever accepts it becomes the creator's friend. */
  async createFriendInvite(
    user: User,
    input: { maxUses?: number | undefined; expiresInHours: number },
  ): Promise<InviteResponse> {
    return this.db.transaction(async (tx) => {
      await tx.query('select 1 from users where id = $1 for update', [user.id]);
      const [active] = await tx.query<Array<{ n: number }>>(
        `select count(*)::int as n from invites
         where kind = 'friend' and created_by = $1 and revoked_at is null and expires_at > now()
           and (max_uses is null or use_count < max_uses)`,
        [user.id],
      );
      if ((active?.n ?? 0) >= MAX_ACTIVE_FRIEND_INVITES) {
        throw new ConflictException({
          code: 'limit',
          message: `At most ${MAX_ACTIVE_FRIEND_INVITES} active friend links; revoke some first`,
        });
      }
      const token = randomBytes(32).toString('base64url');
      const invite = await tx.getRepository(Invite).save(
        tx.getRepository(Invite).create({
          kind: 'friend',
          groupId: null,
          tokenHash: hashToken(token),
          createdBy: user.id,
          maxUses: input.maxUses ?? null,
          useCount: 0,
          expiresAt: new Date(Date.now() + input.expiresInHours * 3_600_000),
        }),
      );
      return { ...toResponse(invite, user.name, null), ...this.link(token) };
    });
  }

  async listFriendInvites(user: User): Promise<InviteResponse[]> {
    const rows = await this.db.query<Invite[]>(
      `select id, expires_at as "expiresAt", max_uses as "maxUses", use_count as "useCount",
              created_by as "createdBy", created_at as "createdAt"
       from invites
       where kind = 'friend' and created_by = $1 and revoked_at is null and expires_at > now()
         and (max_uses is null or use_count < max_uses)
       order by created_at desc`,
      [user.id],
    );
    return rows.map((r) => toResponse(r, user.name, null));
  }

  async revokeFriendInvite(user: User, inviteId: string): Promise<void> {
    const result = UUID.test(inviteId)
      ? await this.db
          .getRepository(Invite)
          .createQueryBuilder()
          .update()
          .set({ revokedAt: () => 'now()' })
          .where(`id = :inviteId and kind = 'friend' and created_by = :me and revoked_at is null`, {
            inviteId,
            me: user.id,
          })
          .execute()
      : { affected: 0 };
    if (!result.affected) throw new NotFoundException('Invite not found');
  }

  private link(token: string): { token: string; url: string | null } {
    const base = this.config.get('PUBLIC_APP_URL', { infer: true });
    return { token, url: base ? new URL(`/join/${token}`, base).toString() : null };
  }

  /** Invites that can still be used (no tokens: those were shown once, at creation). */
  async listActive(groupId: string): Promise<InviteResponse[]> {
    const rows = await this.db.query<
      Array<Record<string, unknown> & { created_by_name: string; placeholder_name: string | null }>
    >(
      `select i.*, u.name as created_by_name, m.placeholder_name
       from invites i
       join users u on u.id = i.created_by
       left join group_members m on m.id = i.placeholder_member_id
       where i.group_id = $1 and i.revoked_at is null and i.expires_at > now()
         and (i.max_uses is null or i.use_count < i.max_uses)
       order by i.created_at desc`,
      [groupId],
    );
    return rows.map((r) => ({
      id: r.id as string,
      expiresAt: (r.expires_at as Date).toISOString(),
      maxUses: (r.max_uses as number | null) ?? null,
      useCount: r.use_count as number,
      placeholder: r.placeholder_member_id
        ? { memberId: r.placeholder_member_id as string, name: r.placeholder_name ?? '' }
        : null,
      createdBy: { userId: r.created_by as string, name: r.created_by_name },
      createdAt: (r.created_at as Date).toISOString(),
    }));
  }

  async revoke(groupId: string, inviteId: string): Promise<void> {
    const result = await this.db
      .getRepository(Invite)
      .createQueryBuilder()
      .update()
      .set({ revokedAt: () => 'now()' })
      .where('id = :inviteId and group_id = :groupId and revoked_at is null', { inviteId, groupId })
      .execute();
    if (!result.affected) throw new NotFoundException('Invite not found');
  }

  /** What the invite is for, so the person can decide before joining. */
  async preview(token: string, user: User): Promise<InvitePreview> {
    const invite = await this.usable(this.db.manager, token);
    const inviter = await this.db.getRepository(User).findOneByOrFail({ id: invite.createdBy });
    if (invite.kind === 'friend') {
      return {
        kind: 'friend',
        group: null,
        invitedBy: inviter.name,
        placeholderName: null,
        expiresAt: invite.expiresAt.toISOString(),
        alreadyMember:
          inviter.id === user.id || (await areFriends(this.db.manager, inviter.id, user.id)),
      };
    }
    const group = await this.db.getRepository(Group).findOneByOrFail({ id: invite.groupId! });
    const [count] = await this.db.query<Array<{ n: number }>>(
      'select count(*)::int as n from group_members where group_id = $1 and left_at is null',
      [group.id],
    );
    const mine = await this.db
      .getRepository(GroupMember)
      .findOneBy({ groupId: group.id, userId: user.id });
    const placeholder = invite.placeholderMemberId
      ? await this.db.getRepository(GroupMember).findOneBy({ id: invite.placeholderMemberId })
      : null;
    return {
      kind: 'group',
      group: { id: group.id, name: group.name, type: group.type, memberCount: count?.n ?? 0 },
      invitedBy: inviter.name,
      placeholderName: placeholder?.placeholderName ?? null,
      expiresAt: invite.expiresAt.toISOString(),
      alreadyMember: !!mine && !mine.leftAt,
    };
  }

  /**
   * Joins the group. In one transaction, with the invite row locked: check the invite is still
   * usable and nobody has blocked anybody, then join (or rejoin as a former member, or take over
   * the placeholder), count the use and write the audit log. Repeating it is harmless.
   */
  async accept(token: string, user: User, requestId: string): Promise<AcceptInviteResponse> {
    return this.db.transaction(async (tx) => {
      const invite = await this.usable(tx, token, true);
      if (invite.kind === 'friend') return this.acceptFriend(tx, invite, user);
      const group = await tx.getRepository(Group).findOneByOrFail({ id: invite.groupId! });
      if (group.archivedAt) {
        throw new ConflictException({ code: 'archived', message: 'This group is archived' });
      }
      if (await eitherBlocked(tx, user.id, invite.createdBy)) {
        throw new ForbiddenException({
          code: 'blocked',
          message: "You can't join through this invite",
        });
      }

      const members = tx.getRepository(GroupMember);
      const existing = await members.findOneBy({ groupId: group.id, userId: user.id });
      if (existing && !existing.leftAt) {
        return groupResult(group.id, existing.id, 'already');
      }

      let outcome: AcceptInviteResponse['outcome'];
      let memberId: string;
      if (invite.placeholderMemberId) {
        if (existing) {
          throw new ConflictException({
            code: 'already_member',
            message: 'You already have a place in this group, so you can’t take over another one',
          });
        }
        const claimed = await members
          .createQueryBuilder()
          .update()
          .set({ userId: user.id, claimedAt: () => 'now()' })
          .where('id = :id and user_id is null and left_at is null', {
            id: invite.placeholderMemberId,
          })
          .execute();
        if (!claimed.affected)
          throw new GoneException({ code: 'invite_used_up', message: 'This invite has been used' });
        memberId = invite.placeholderMemberId;
        outcome = 'claimed';
      } else if (existing) {
        await members.update(
          { id: existing.id },
          { leftAt: null, removedBy: null, joinedAt: new Date() },
        );
        memberId = existing.id;
        outcome = 'rejoined';
      } else {
        const created = await members.save(
          members.create({
            groupId: group.id,
            userId: user.id,
            role: 'member',
            notifyLevel: 'all',
            invitedBy: invite.createdBy,
            joinedAt: new Date(),
          }),
        );
        memberId = created.id;
        outcome = 'joined';
      }

      await tx.getRepository(Invite).increment({ id: invite.id }, 'useCount', 1);
      await audit(
        tx,
        group.id,
        memberId,
        user.id,
        outcome === 'claimed' ? 'claim' : 'join',
        requestId,
        {
          inviteId: invite.id,
        },
      );
      return groupResult(group.id, memberId, outcome);
    });
  }

  private async acceptFriend(
    tx: EntityManager,
    invite: Invite,
    user: User,
  ): Promise<AcceptInviteResponse> {
    const result = (outcome: 'befriended' | 'already'): AcceptInviteResponse => ({
      kind: 'friend',
      groupId: null,
      memberId: null,
      friendUserId: invite.createdBy,
      outcome,
    });
    if (invite.createdBy === user.id) {
      throw new BadRequestException({ code: 'self', message: 'This is your own link' });
    }
    if (await eitherBlocked(tx, user.id, invite.createdBy)) {
      throw new ForbiddenException({ code: 'blocked', message: "You can't use this invite" });
    }
    if (await areFriends(tx, user.id, invite.createdBy)) return result('already');
    await befriend(tx, invite.createdBy, user.id, 'invite');
    await tx.getRepository(Invite).increment({ id: invite.id }, 'useCount', 1);
    return result('befriended');
  }

  /** Finds an invite by token; 404 if unknown, 410 if expired, revoked or used up. */
  private async usable(manager: EntityManager, token: string, lock = false): Promise<Invite> {
    const qb = manager
      .getRepository(Invite)
      .createQueryBuilder('i')
      .where('i.token_hash = :hash', { hash: hashToken(token) });
    if (lock) qb.setLock('pessimistic_write');
    const invite = await qb.getOne();
    if (!invite)
      throw new NotFoundException({
        code: 'invite_not_found',
        message: 'This invite link is not valid',
      });
    if (invite.revokedAt)
      throw new GoneException({ code: 'invite_revoked', message: 'This invite was cancelled' });
    if (invite.expiresAt <= new Date())
      throw new GoneException({ code: 'invite_expired', message: 'This invite has expired' });
    if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
      throw new GoneException({ code: 'invite_used_up', message: 'This invite has been used' });
    }
    return invite;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function groupResult(
  groupId: string,
  memberId: string,
  outcome: 'joined' | 'rejoined' | 'claimed' | 'already',
): AcceptInviteResponse {
  return { kind: 'group', groupId, memberId, friendUserId: null, outcome };
}

function toResponse(
  invite: Pick<Invite, 'id' | 'expiresAt' | 'maxUses' | 'useCount' | 'createdBy' | 'createdAt'>,
  createdByName: string,
  placeholder: GroupMember | null,
): InviteResponse {
  return {
    id: invite.id,
    expiresAt: invite.expiresAt.toISOString(),
    maxUses: invite.maxUses,
    useCount: invite.useCount,
    placeholder: placeholder
      ? { memberId: placeholder.id, name: placeholder.placeholderName ?? '' }
      : null,
    createdBy: { userId: invite.createdBy, name: createdByName },
    createdAt: invite.createdAt.toISOString(),
  };
}
