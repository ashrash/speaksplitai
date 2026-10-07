import { Controller, Get } from '@nestjs/common';
import type { MeResponse } from '@speaksplit/api-types';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { User } from '../database/entities/index.js';

@Controller('me')
export class MeController {
  @Get()
  me(@CurrentUser() user: User): MeResponse {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      locale: user.locale,
      defaultCurrency: user.defaultCurrency as MeResponse['defaultCurrency'],
    };
  }
}
