import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { JWTPayload } from 'jose';
import { DataSource } from 'typeorm';
import type { Env } from '../config/env.js';
import { User } from '../database/entities/index.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

@Injectable()
export class UsersService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Finds the user for a verified token, creating them on their first request. The display name
   * comes from the token, and so does the email, but only when Auth0 marks it verified (it is
   * what friend requests by email are matched against).
   */
  async findOrCreate(claims: JWTPayload & { sub: string }): Promise<User> {
    const repo = this.db.getRepository(User);
    let user = await repo.findOneBy({ authSubject: claims.sub });
    if (!user) {
      await repo
        .createQueryBuilder()
        .insert()
        .values({ authSubject: claims.sub, name: displayName(claims) })
        .orIgnore() // two first requests at once: one inserts, the other reads it back
        .execute();
      user = await repo.findOneByOrFail({ authSubject: claims.sub });
    }
    await this.syncVerifiedEmail(user, claims);
    return user;
  }

  /**
   * Keeps users.email equal to the token's verified email. Skipped (left as is) when the
   * address belongs to another active account, e.g. the same person signed up twice.
   */
  private async syncVerifiedEmail(user: User, claims: JWTPayload): Promise<void> {
    const email = this.claim(claims, 'email');
    if (this.claim(claims, 'email_verified') !== true || typeof email !== 'string') return;
    const normalised = email.trim().toLowerCase();
    if (!EMAIL.test(normalised) || user.email === normalised) return;
    try {
      const result = await this.db.query<[unknown[], number]>(
        `update users set email = $1
         where id = $2
           and not exists (select 1 from users o where o.email = $1 and o.deleted_at is null and o.id <> $2)`,
        [normalised, user.id],
      );
      if (result[1] > 0) user.email = normalised;
    } catch {
      // lost a race for the same address with another account: keep the old value
    }
  }

  private claim(claims: JWTPayload, name: string): unknown {
    const ns = this.config.get('AUTH0_CLAIM_NAMESPACE', { infer: true });
    return claims[name] ?? (ns ? claims[`${ns}${name}`] : undefined);
  }
}

function displayName(claims: JWTPayload): string {
  for (const key of ['name', 'nickname', 'given_name'] as const) {
    const value = claims[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 80);
  }
  const email = claims.email;
  if (typeof email === 'string' && email.includes('@')) return email.split('@')[0]!.slice(0, 80);
  return 'New user';
}
