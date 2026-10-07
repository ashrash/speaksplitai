import {
  Body,
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
  type ExpenseDetail,
  type ExpenseListResponse,
  expenseRequestSchema,
  listExpensesQuerySchema,
  updateExpenseRequestSchema,
} from '@speaksplit/api-types';
import type { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Idempotent } from '../common/idempotency.js';
import type { AppRequest } from '../common/request.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { User } from '../database/entities/index.js';
import { GroupAccess, membershipOf } from '../groups/group-access.js';
import { ExpensesService } from './expenses.service.js';

@Controller('groups/:groupId/expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Post()
  @GroupAccess('write')
  @Idempotent()
  create(
    @Param('groupId') groupId: string,
    @CurrentUser() user: User,
    @Body(new ZodPipe(expenseRequestSchema)) body: z.output<typeof expenseRequestSchema>,
    @Req() req: AppRequest,
  ): Promise<ExpenseDetail> {
    return this.expenses.create(groupId, user, body, req.id);
  }

  /** Defaults to the expenses you paid for or are part of; `?scope=all` for everything. */
  @Get()
  @GroupAccess('read')
  list(
    @Param('groupId') groupId: string,
    @Query(new ZodPipe(listExpensesQuerySchema)) query: z.output<typeof listExpensesQuerySchema>,
    @Req() req: AppRequest,
  ): Promise<ExpenseListResponse> {
    return this.expenses.list(groupId, membershipOf(req), query);
  }

  @Get(':expenseId')
  @GroupAccess('read')
  detail(
    @Param('groupId') groupId: string,
    @Param('expenseId') expenseId: string,
  ): Promise<ExpenseDetail> {
    return this.expenses.detail(groupId, expenseId);
  }

  @Patch(':expenseId')
  @GroupAccess('write')
  update(
    @Param('groupId') groupId: string,
    @Param('expenseId') expenseId: string,
    @CurrentUser() user: User,
    @Body(new ZodPipe(updateExpenseRequestSchema))
    body: z.output<typeof updateExpenseRequestSchema>,
    @Req() req: AppRequest,
  ): Promise<ExpenseDetail> {
    return this.expenses.update(groupId, expenseId, user, body, req.id);
  }

  @Delete(':expenseId')
  @HttpCode(204)
  @GroupAccess('write')
  async remove(
    @Param('groupId') groupId: string,
    @Param('expenseId') expenseId: string,
    @CurrentUser() user: User,
    @Req() req: AppRequest,
  ): Promise<void> {
    await this.expenses.remove(groupId, expenseId, user, req.id);
  }

  @Post(':expenseId/restore')
  @HttpCode(200)
  @GroupAccess('write')
  restore(
    @Param('groupId') groupId: string,
    @Param('expenseId') expenseId: string,
    @CurrentUser() user: User,
    @Req() req: AppRequest,
  ): Promise<ExpenseDetail> {
    return this.expenses.restore(groupId, expenseId, user, req.id);
  }
}
