import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AppRequest } from '../common/request.js';
import type { Env } from '../config/env.js';
import { UsersService } from '../users/users.service.js';
import { JWKS } from './jwks.js';
import { IS_PUBLIC } from './public.decorator.js';

/**
 * Global guard: every route needs a valid Auth0 access token unless marked @Public().
 * Checks the RS256 signature against the tenant's JWKS, plus `iss`, `aud` and `exp`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly users: UsersService,
    private readonly config: ConfigService<Env, true>,
    @Inject(JWKS) private readonly jwks: JWTVerifyGetKey,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const req = context.switchToHttp().getRequest<AppRequest>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Sign in required');
    }

    let sub: string | undefined;
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.get('AUTH0_ISSUER_URL', { infer: true }),
        audience: this.config.get('AUTH0_AUDIENCE', { infer: true }),
        algorithms: ['RS256'],
      }));
      sub = payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (!sub) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const user = await this.users.findOrCreate({ ...payload, sub });
    if (user.deletedAt) {
      throw new UnauthorizedException('This account has been deleted');
    }
    req.user = user;
    return true;
  }
}
