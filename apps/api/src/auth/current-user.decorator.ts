import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { User } from '../database/entities/index.js';
import type { AppRequest } from '../common/request.js';

/** The signed-in user, created on their first authenticated request. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): User => {
  const user = ctx.switchToHttp().getRequest<AppRequest>().user;
  if (!user) {
    throw new Error('CurrentUser used on a route without authentication');
  }
  return user;
});
