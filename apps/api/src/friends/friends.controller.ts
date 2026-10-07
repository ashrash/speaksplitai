import { Body, Controller, Delete, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import {
  createFriendInviteRequestSchema,
  type Friend,
  friendRequestSchema,
  type FriendRequestResult,
  type FriendRequestsResponse,
  type InviteResponse,
} from '@speaksplit/api-types';
import type { Response } from 'express';
import type { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { User } from '../database/entities/index.js';
import { InvitesService } from '../groups/invites.service.js';
import { FriendsService } from './friends.service.js';

@Controller('friends')
export class FriendsController {
  constructor(
    private readonly friends: FriendsService,
    private readonly invites: InvitesService,
  ) {}

  @Get()
  list(@CurrentUser() user: User): Promise<Friend[]> {
    return this.friends.list(user);
  }

  @Delete(':userId')
  @HttpCode(204)
  async unfriend(@CurrentUser() user: User, @Param('userId') userId: string): Promise<void> {
    await this.friends.unfriend(user, userId);
  }

  /** 202 when sent (always, for email and phone); 200 when it changed nothing or connected you. */
  @Post('requests')
  async request(
    @CurrentUser() user: User,
    @Body(new ZodPipe(friendRequestSchema)) body: z.output<typeof friendRequestSchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FriendRequestResult> {
    const result = await this.friends.request(user, body);
    res.status(result.status === 'sent' ? 202 : 200);
    return result;
  }

  @Get('requests')
  requests(@CurrentUser() user: User): Promise<FriendRequestsResponse> {
    return this.friends.listRequests(user);
  }

  @Post('requests/:id/accept')
  @HttpCode(200)
  accept(@CurrentUser() user: User, @Param('id') id: string): Promise<{ friendUserId: string }> {
    return this.friends.accept(user, id);
  }

  @Post('requests/:id/decline')
  @HttpCode(204)
  async decline(@CurrentUser() user: User, @Param('id') id: string): Promise<void> {
    await this.friends.decline(user, id);
  }

  @Delete('requests/:id')
  @HttpCode(204)
  async cancel(@CurrentUser() user: User, @Param('id') id: string): Promise<void> {
    await this.friends.cancel(user, id);
  }

  /** A personal "add me" link; whoever opens it becomes your friend. */
  @Post('invites')
  createInvite(
    @CurrentUser() user: User,
    @Body(new ZodPipe(createFriendInviteRequestSchema))
    body: z.output<typeof createFriendInviteRequestSchema>,
  ): Promise<InviteResponse> {
    return this.invites.createFriendInvite(user, body);
  }

  @Get('invites')
  listInvites(@CurrentUser() user: User): Promise<InviteResponse[]> {
    return this.invites.listFriendInvites(user);
  }

  @Delete('invites/:inviteId')
  @HttpCode(204)
  async revokeInvite(
    @CurrentUser() user: User,
    @Param('inviteId') inviteId: string,
  ): Promise<void> {
    await this.invites.revokeFriendInvite(user, inviteId);
  }
}
