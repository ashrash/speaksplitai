import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  addUpiIdRequestSchema,
  type MeResponse,
  updateMeRequestSchema,
  updateUpiIdRequestSchema,
  type UpiId,
} from '@speaksplit/api-types';
import type { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { User } from '../database/entities/index.js';
import { ProfileService } from './profile.service.js';

@Controller('me')
export class MeController {
  constructor(private readonly profile: ProfileService) {}

  @Get()
  me(@CurrentUser() user: User): Promise<MeResponse> {
    return this.profile.me(user);
  }

  @Patch()
  update(
    @CurrentUser() user: User,
    @Body(new ZodPipe(updateMeRequestSchema)) body: z.output<typeof updateMeRequestSchema>,
  ): Promise<MeResponse> {
    return this.profile.update(user, body);
  }

  @Get('upi-ids')
  async upiIds(@CurrentUser() user: User): Promise<UpiId[]> {
    return (await this.profile.me(user)).upiIds;
  }

  // Not @Idempotent: a retried add hits the unique (user, vpa) index and gets 409.
  @Post('upi-ids')
  addUpiId(
    @CurrentUser() user: User,
    @Body(new ZodPipe(addUpiIdRequestSchema)) body: z.output<typeof addUpiIdRequestSchema>,
  ): Promise<UpiId> {
    return this.profile.addUpiId(user, body);
  }

  @Patch('upi-ids/:id')
  updateUpiId(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body(new ZodPipe(updateUpiIdRequestSchema)) body: z.output<typeof updateUpiIdRequestSchema>,
  ): Promise<UpiId> {
    return this.profile.updateUpiId(user, id, body);
  }

  @Delete('upi-ids/:id')
  @HttpCode(204)
  async removeUpiId(@CurrentUser() user: User, @Param('id') id: string): Promise<void> {
    await this.profile.removeUpiId(user, id);
  }
}
