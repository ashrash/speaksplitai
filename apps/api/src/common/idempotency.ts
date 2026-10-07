import { createHash } from 'node:crypto';
import {
  BadRequestException,
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  type NestInterceptor,
  UnprocessableEntityException,
  UseInterceptors,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { catchError, from, type Observable, of, switchMap, throwError } from 'rxjs';
import { DataSource, LessThan } from 'typeorm';
import { IdempotencyKey } from '../database/entities/index.js';
import type { AppRequest } from './request.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Makes a create endpoint safe to retry. The client sends an `Idempotency-Key` header (for
 * example a UUID generated when the user taps Save); a retry with the same key and body gets
 * the original response back instead of creating a duplicate.
 *
 * - same key, same request, finished: the stored response is replayed (header Idempotent-Replayed)
 * - same key, same request, still running: 409
 * - same key, different request: 422
 * - the handler fails: the key is released so the client can retry
 * Keys are per user and expire after 24 hours.
 */
export const Idempotent = () => UseInterceptors(IdempotencyInterceptor);

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @InjectDataSource() private readonly db: DataSource,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const key = req.headers[IDEMPOTENCY_HEADER];
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw new BadRequestException({
        code: 'idempotency_key_required',
        message: 'Send an Idempotency-Key header (8-128 letters, digits, - or _)',
      });
    }
    if (!req.user) {
      throw new Error('Idempotent routes must be authenticated');
    }
    const userId = req.user.id;
    const path = req.baseUrl + req.path;
    const requestHash = createHash('sha256')
      .update(canonicalJson({ method: req.method, path, body: req.body ?? null }))
      .digest();
    const successStatus =
      this.reflector.get<number>(HTTP_CODE_METADATA, context.getHandler()) ??
      (req.method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK);
    const repo = this.db.getRepository(IdempotencyKey);

    return from(this.claim(userId, key, req.method, path, requestHash)).pipe(
      switchMap((existing) => {
        if (existing) {
          if (!existing.requestHash.equals(requestHash)) {
            throw new UnprocessableEntityException({
              code: 'idempotency_key_reused',
              message: 'This Idempotency-Key was already used for a different request',
            });
          }
          if (existing.status === 'in_progress') {
            throw new ConflictException({
              code: 'request_in_progress',
              message: 'A request with this Idempotency-Key is still being processed',
            });
          }
          res.status(existing.responseStatus ?? HttpStatus.OK);
          res.setHeader('Idempotent-Replayed', 'true');
          return of(existing.responseBody);
        }
        return next.handle().pipe(
          switchMap((body) =>
            from(
              repo.update(
                { userId, idemKey: key },
                { status: 'completed', responseStatus: successStatus, responseBody: body ?? null },
              ),
            ).pipe(switchMap(() => of(body))),
          ),
          catchError((err) =>
            from(repo.delete({ userId, idemKey: key })).pipe(
              switchMap(() => throwError(() => err)),
            ),
          ),
        );
      }),
    );
  }

  /** Inserts an in-progress row; returns the existing row if the key is already taken. */
  private async claim(
    userId: string,
    key: string,
    method: string,
    path: string,
    requestHash: Buffer,
  ): Promise<IdempotencyKey | null> {
    const repo = this.db.getRepository(IdempotencyKey);
    await repo.delete({ userId, idemKey: key, expiresAt: LessThan(new Date()) });
    const inserted = await repo
      .createQueryBuilder()
      .insert()
      .values({ userId, idemKey: key, method, path, requestHash, status: 'in_progress' })
      .orIgnore()
      .returning(['idem_key'])
      .execute();
    if (inserted.raw.length > 0) return null;
    return repo.findOneByOrFail({ userId, idemKey: key });
  }
}

/** JSON with object keys sorted at every level, so key order doesn't change the hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}
