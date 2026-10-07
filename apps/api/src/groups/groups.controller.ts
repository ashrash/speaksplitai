import { Body, ConflictException, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import {
  createGroupRequestSchema,
  type GroupDetailResponse,
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
  list(@CurrentUser() user: User): Promise<GroupResponse[]> {
    return this.groups.listMine(user);
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
}
