import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  createGroupRequestSchema,
  type DirectGroupResponse,
  type GroupDetailResponse,
  listGroupsQuerySchema,
  openDirectRequestSchema,
  type GroupResponse,
  updateGroupRequestSchema,
} from '@speaksplit/api-types';
import type { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Idempotent } from '../common/idempotency.js';
import type { AppRequest } from '../common/request.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { User } from '../database/entities/index.js';
import { GroupAccess, membershipOf } from './group-access.js';
import { GroupsService, StaleVersionError } from './groups.service.js';

@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentUser() user: User,
    @Body(new ZodPipe(createGroupRequestSchema)) body: z.output<typeof createGroupRequestSchema>,
    @Req() req: AppRequest,
  ): Promise<GroupResponse> {
    return this.groups.create(user, body, req.id);
  }

  @Get()
  list(
    @CurrentUser() user: User,
    @Query(new ZodPipe(listGroupsQuerySchema)) query: z.output<typeof listGroupsQuerySchema>,
  ): Promise<GroupResponse[]> {
    return this.groups.listMine(user, query.status);
  }

  @Get(':groupId')
  @GroupAccess('read')
  detail(@Param('groupId') groupId: string, @Req() req: AppRequest): Promise<GroupDetailResponse> {
    return this.groups.detail(groupId, membershipOf(req));
  }

  @Patch(':groupId')
  @GroupAccess('write')
  async update(
    @Param('groupId') groupId: string,
    @CurrentUser() user: User,
    @Body(new ZodPipe(updateGroupRequestSchema)) body: z.output<typeof updateGroupRequestSchema>,
    @Req() req: AppRequest,
  ): Promise<GroupResponse> {
    try {
      return await this.groups.update(groupId, membershipOf(req), user, body, req.id);
    } catch (err) {
      if (err instanceof StaleVersionError) {
        throw new ConflictException({
          code: 'stale_version',
          message: 'Someone else changed this group first; reload and try again',
        });
      }
      throw err;
    }
  }

  @Post(':groupId/archive')
  @HttpCode(200)
  @GroupAccess('manage')
  archive(
    @Param('groupId') groupId: string,
    @CurrentUser() user: User,
    @Req() req: AppRequest,
  ): Promise<GroupResponse> {
    return this.groups.setArchived(groupId, membershipOf(req), user, true, req.id);
  }

  @Post(':groupId/unarchive')
  @HttpCode(200)
  @GroupAccess('manage')
  unarchive(
    @Param('groupId') groupId: string,
    @CurrentUser() user: User,
    @Req() req: AppRequest,
  ): Promise<GroupResponse> {
    return this.groups.setArchived(groupId, membershipOf(req), user, false, req.id);
  }

  /** Only when everyone is settled up; removes the group and everything in it. */
  @Delete(':groupId')
  @HttpCode(204)
  @GroupAccess('manage')
  async remove(
    @Param('groupId') groupId: string,
    @CurrentUser() user: User,
    @Req() req: AppRequest,
  ): Promise<void> {
    await this.groups.remove(groupId, user, req.id);
  }
}

/** Friend-to-friend expenses live in a hidden two-person group per pair. */
@Controller('direct')
export class DirectController {
  constructor(private readonly groups: GroupsService) {}

  /** Returns the group with this person, creating it the first time (safe to repeat). */
  @Post()
  @HttpCode(200)
  open(
    @CurrentUser() user: User,
    @Body(new ZodPipe(openDirectRequestSchema)) body: z.output<typeof openDirectRequestSchema>,
    @Req() req: AppRequest,
  ): Promise<DirectGroupResponse> {
    return this.groups.openDirect(user, body.userId, req.id);
  }

  @Get()
  list(@CurrentUser() user: User): Promise<DirectGroupResponse[]> {
    return this.groups.listDirect(user);
  }
}
