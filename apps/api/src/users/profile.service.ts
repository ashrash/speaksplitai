import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type {
  AddUpiIdRequest,
  MeResponse,
  UpdateMeRequest,
  UpdateUpiIdRequest,
  UpiId,
} from '@speaksplit/api-types';
import { DataSource, type EntityManager } from 'typeorm';
import { User, UserUpiId } from '../database/entities/index.js';

/** Plenty for real use; stops a runaway client filling the table. */
export const MAX_UPI_IDS = 10;

@Injectable()
export class ProfileService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async me(user: User): Promise<MeResponse> {
    const upiIds = await this.listUpiIds(this.db.manager, user.id);
    return toMe(user, upiIds);
  }

  async update(user: User, input: UpdateMeRequest): Promise<MeResponse> {
    const changes: Partial<User> = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.avatarUrl !== undefined) changes.avatarUrl = input.avatarUrl;
    if (input.locale !== undefined) changes.locale = input.locale;
    if (input.defaultCurrency !== undefined) changes.defaultCurrency = input.defaultCurrency;
    await this.db.getRepository(User).update({ id: user.id }, changes);
    const fresh = await this.db.getRepository(User).findOneByOrFail({ id: user.id });
    return this.me(fresh);
  }

  async listUpiIds(manager: EntityManager, userId: string): Promise<UpiId[]> {
    const rows = await manager.getRepository(UserUpiId).find({
      where: { userId },
      order: { isPrimary: 'DESC', createdAt: 'ASC', id: 'ASC' },
    });
    return rows.map(toUpiId);
  }

  /** Adds a UPI ID. The first one is primary; a later one becomes primary only if asked. */
  async addUpiId(user: User, input: AddUpiIdRequest): Promise<UpiId> {
    return this.withUserLock(user.id, async (tx) => {
      const repo = tx.getRepository(UserUpiId);
      const count = await repo.countBy({ userId: user.id });
      if (count >= MAX_UPI_IDS) {
        throw new ConflictException({ code: 'limit', message: `At most ${MAX_UPI_IDS} UPI IDs` });
      }
      const isPrimary = count === 0 || input.isPrimary === true;
      if (isPrimary) {
        await repo.update({ userId: user.id, isPrimary: true }, { isPrimary: false });
      }
      const saved = await repo.save(
        repo.create({ userId: user.id, vpa: input.vpa, label: input.label ?? null, isPrimary }),
      );
      return toUpiId(saved);
    });
  }

  async updateUpiId(user: User, id: string, input: UpdateUpiIdRequest): Promise<UpiId> {
    return this.withUserLock(user.id, async (tx) => {
      const repo = tx.getRepository(UserUpiId);
      const row = await this.ownUpiId(tx, user.id, id);
      if (input.isPrimary && !row.isPrimary) {
        // clear the old primary first: at most one primary per user is a unique index
        await repo.update({ userId: user.id, isPrimary: true }, { isPrimary: false });
        row.isPrimary = true;
      }
      if (input.label !== undefined) row.label = input.label;
      return toUpiId(await repo.save(row));
    });
  }

  /** Removes a UPI ID; if it was primary, the oldest remaining one becomes primary. */
  async removeUpiId(user: User, id: string): Promise<void> {
    await this.withUserLock(user.id, async (tx) => {
      const repo = tx.getRepository(UserUpiId);
      const row = await this.ownUpiId(tx, user.id, id);
      await repo.delete({ id: row.id });
      if (row.isPrimary) {
        const next = await repo.findOne({
          where: { userId: user.id },
          order: { createdAt: 'ASC', id: 'ASC' },
        });
        if (next) await repo.update({ id: next.id }, { isPrimary: true });
      }
    });
  }

  private async ownUpiId(tx: EntityManager, userId: string, id: string): Promise<UserUpiId> {
    const row = UUID.test(id) ? await tx.getRepository(UserUpiId).findOneBy({ id, userId }) : null;
    if (!row) throw new NotFoundException('UPI ID not found');
    return row;
  }

  /** Serialises a user's UPI ID changes so two "make primary" taps can't race. */
  private withUserLock<T>(userId: string, fn: (tx: EntityManager) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.query('select 1 from users where id = $1 for update', [userId]);
      return fn(tx);
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toUpiId(row: UserUpiId): UpiId {
  return { id: row.id, vpa: row.vpa, label: row.label, isPrimary: row.isPrimary };
}

function toMe(user: User, upiIds: UpiId[]): MeResponse {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    locale: user.locale,
    defaultCurrency: user.defaultCurrency as MeResponse['defaultCurrency'],
    upiIds,
  };
}
