import {
  applyDecorators,
  type CanActivate,
  ConflictException,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AppRequest } from '../common/request.js';
import { Group, GroupMember } from '../database/entities/index.js';

export type GroupAccessLevel = 'read' | 'write' | 'manage';
const GROUP_ACCESS = 'groupAccess';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one place group-scoped routes are authorised, using the `:groupId` route parameter.
 *
 * - read: any member, including former members (they keep read-only access to history).
 * - write: current members only, and not in an archived group.
 * - manage (archive, unarchive, delete): current members who own the group (either member of a
 *   friend-to-friend group); allowed on archived groups.
 *
 * Non-members get 404, so group ids can't be probed.
 */
export const GroupAccess = (level: GroupAccessLevel) =>
  applyDecorators(SetMetadata(GROUP_ACCESS, level), UseGuards(GroupAccessGuard));

@Injectable()
export class GroupAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectDataSource() private readonly db: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const level = this.reflector.get<GroupAccessLevel>(GROUP_ACCESS, context.getHandler());
    const req = context.switchToHttp().getRequest<AppRequest>();
    const groupId = req.params.groupId;
    if (!req.user || !level) {
      throw new Error('GroupAccessGuard needs an authenticated user and a @GroupAccess level');
    }
    if (typeof groupId !== 'string' || !UUID.test(groupId)) {
      throw new NotFoundException('Group not found');
    }

    const membership = await this.db
      .getRepository(GroupMember)
      .findOneBy({ groupId, userId: req.user.id });
    if (!membership) {
      throw new NotFoundException('Group not found');
    }
    if (level !== 'read') {
      if (membership.leftAt) {
        throw new ForbiddenException('You left this group; its history is read-only for you');
      }
      const group = await this.db.getRepository(Group).findOneByOrFail({ id: groupId });
      if (level === 'write' && group.archivedAt) {
        throw new ConflictException({ code: 'archived', message: 'This group is archived' });
      }
      if (level === 'manage' && group.type !== 'direct' && membership.role !== 'owner') {
        throw new ForbiddenException('Only the group owner can do this');
      }
    }
    req.membership = membership;
    return true;
  }
}

/** The caller's membership row, set by GroupAccessGuard. */
export function membershipOf(req: AppRequest): GroupMember {
  if (!req.membership) {
    throw new Error('membershipOf used on a route without @GroupAccess');
  }
  return req.membership;
}
