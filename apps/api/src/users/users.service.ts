import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { JWTPayload } from 'jose';
import { DataSource } from 'typeorm';
import { User } from '../database/entities/index.js';

@Injectable()
export class UsersService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /**
   * Finds the user for a verified token, creating them on their first request. Only a display
   * name is taken from the token; email and phone are set later through the profile, so an
   * unverified or shared email can't collide with another account.
   */
  async findOrCreate(claims: JWTPayload & { sub: string }): Promise<User> {
    const repo = this.db.getRepository(User);
    const existing = await repo.findOneBy({ authSubject: claims.sub });
    if (existing) return existing;

    await repo
      .createQueryBuilder()
      .insert()
      .values({ authSubject: claims.sub, name: displayName(claims) })
      .orIgnore() // two first requests at once: one inserts, the other reads it back
      .execute();
    return repo.findOneByOrFail({ authSubject: claims.sub });
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
