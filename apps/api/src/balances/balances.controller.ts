import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  type GroupBalancesResponse,
  listSettlementsQuerySchema,
  type MyBalancesResponse,
  payLinkQuerySchema,
  type PayLinkResponse,
  recordSettlementRequestSchema,
  type SettlementListResponse,
  type SettlementView,
} from '@speaksplit/api-types';
import type { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Idempotent } from '../common/idempotency.js';
import type { AppRequest } from '../common/request.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { User } from '../database/entities/index.js';
import { GroupAccess, membershipOf } from '../groups/group-access.js';
import { BalancesService } from './balances.service.js';
import { SettlementsService } from './settlements.service.js';

@Controller('groups/:groupId')
export class GroupBalancesController {
  constructor(
    private readonly balances: BalancesService,
    private readonly settlements: SettlementsService,
  ) {}

  @Get('balances')
  @GroupAccess('read')
  groupBalances(@Param('groupId') groupId: string): Promise<GroupBalancesResponse> {
    return this.balances.forGroup(groupId);
  }

  /** Records a payment (payer or payee only). Counts at once; must clear the full amount owed. */
  @Post('settlements')
  @GroupAccess('write')
  @Idempotent()
  record(
    @Param('groupId') groupId: string,
    @CurrentUser() user: User,
    @Body(new ZodPipe(recordSettlementRequestSchema))
    body: z.output<typeof recordSettlementRequestSchema>,
    @Req() req: AppRequest,
  ): Promise<SettlementView> {
    return this.settlements.record(groupId, membershipOf(req), user, body, req.id);
  }

  @Get('settlements')
  @GroupAccess('read')
  list(
    @Param('groupId') groupId: string,
    @Query(new ZodPipe(listSettlementsQuerySchema))
    query: z.output<typeof listSettlementsQuerySchema>,
  ): Promise<SettlementListResponse> {
    return this.settlements.list(groupId, query);
  }

  @Delete('settlements/:settlementId')
  @HttpCode(204)
  @GroupAccess('write')
  async cancel(
    @Param('groupId') groupId: string,
    @Param('settlementId') settlementId: string,
    @CurrentUser() user: User,
    @Req() req: AppRequest,
  ): Promise<void> {
    await this.settlements.cancel(groupId, settlementId, membershipOf(req), user, req.id);
  }

  /** The payee's UPI ID and a upi://pay link for the amount. */
  @Get('pay-link')
  @GroupAccess('write')
  payLink(
    @Param('groupId') groupId: string,
    @Query(new ZodPipe(payLinkQuerySchema)) query: z.output<typeof payLinkQuerySchema>,
  ): Promise<PayLinkResponse> {
    return this.settlements.payLink(groupId, query.toMemberId, query.amountMinor);
  }
}

@Controller('me/balances')
export class MyBalancesController {
  constructor(private readonly balances: BalancesService) {}

  @Get()
  mine(@CurrentUser() user: User): Promise<MyBalancesResponse> {
    return this.balances.forUser(user);
  }
}
