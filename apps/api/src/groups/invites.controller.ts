import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  type AcceptInviteResponse,
  addPlaceholderRequestSchema,
  createInviteRequestSchema,
  type InvitePreview,
  type InviteResponse,
  inviteTokenSchema,
} from '@speaksplit/api-types';
import type { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AppRequest } from '../common/request.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { User } from '../database/entities/index.js';
import { GroupAccess, membershipOf } from './group-access.js';
import { InvitesService } from './invites.service.js';
import { MembersService } from './members.service.js';

@Controller('groups/:groupId')
export class GroupMembersController {
  constructor(
    private readonly invites: InvitesService,
    private readonly members: MembersService,
  ) {}

  @Post('invites')
  @GroupAccess('write')
  createInvite(
    @Param('groupId') groupId: string,
    @CurrentUser() user: User,
    @Body(new ZodPipe(createInviteRequestSchema)) body: z.output<typeof createInviteRequestSchema>,
  ): Promise<InviteResponse> {
    return this.invites.create(groupId, user, body);
  }

  @Get('invites')
  @GroupAccess('write')
  listInvites(@Param('groupId') groupId: string): Promise<InviteResponse[]> {
    return this.invites.listActive(groupId);
  }

  @Delete('invites/:inviteId')
  @HttpCode(204)
  @GroupAccess('write')
  async revokeInvite(
    @Param('groupId') groupId: string,
    @Param('inviteId') inviteId: string,
  ): Promise<void> {
    if (!UUID.test(inviteId)) throw new NotFoundException('Invite not found');
    await this.invites.revoke(groupId, inviteId);
  }

  /** Adds someone by name before they've joined. */
  @Post('members')
  @GroupAccess('write')
  addPlaceholder(
    @Param('groupId') groupId: string,
    @CurrentUser() user: User,
    @Body(new ZodPipe(addPlaceholderRequestSchema))
    body: z.output<typeof addPlaceholderRequestSchema>,
    @Req() req: AppRequest,
  ) {
    return this.members.addPlaceholder(groupId, user, body.name, req.id);
  }

  @Delete('members/:memberId')
  @HttpCode(204)
  @GroupAccess('manage')
  async removeMember(
    @Param('groupId') groupId: string,
    @Param('memberId') memberId: string,
    @CurrentUser() user: User,
    @Req() req: AppRequest,
  ): Promise<void> {
    if (memberId === membershipOf(req).id) {
      return this.members.leave(groupId, membershipOf(req), user, req.id);
    }
    await this.members.remove(groupId, memberId, user, req.id);
  }

  @Post('leave')
  @HttpCode(204)
  @GroupAccess('member')
  async leave(
    @Param('groupId') groupId: string,
    @CurrentUser() user: User,
    @Req() req: AppRequest,
  ): Promise<void> {
    await this.members.leave(groupId, membershipOf(req), user, req.id);
  }
}

/** Opening an invite link: the person isn't a member yet, so these take the token, not a group id. */
@Controller('invites/:token')
export class InviteLinksController {
  constructor(private readonly invites: InvitesService) {}

  @Get()
  preview(
    @Param('token', new ZodPipe(inviteTokenSchema)) token: string,
    @CurrentUser() user: User,
  ): Promise<InvitePreview> {
    return this.invites.preview(token, user);
  }

  @Post('accept')
  @HttpCode(200)
  accept(
    @Param('token', new ZodPipe(inviteTokenSchema)) token: string,
    @CurrentUser() user: User,
    @Req() req: AppRequest,
  ): Promise<AcceptInviteResponse> {
    return this.invites.accept(token, user, req.id);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
