import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { OptimisticLockVersionMismatchError, QueryFailedError } from 'typeorm';
import type { AppRequest } from './request.js';

export interface ErrorBody {
  error: {
    status: number;
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

/** Postgres SQLSTATE codes we expect from constraint checks, and what they mean to a client. */
const PG_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  '23514': { status: 422, code: 'constraint_violation', message: 'The request breaks a data rule' },
  '23503': {
    status: 422,
    code: 'reference_not_found',
    message: 'The request refers to something that does not exist',
  },
  '23505': { status: 409, code: 'conflict', message: 'That already exists' },
  '23001': { status: 409, code: 'restricted', message: 'That cannot be deleted' },
  '40001': {
    status: 409,
    code: 'retry',
    message: 'The request conflicted with another one; try again',
  },
  '40P01': {
    status: 409,
    code: 'retry',
    message: 'The request conflicted with another one; try again',
  },
};

/**
 * Turns every error into `{ error: { status, code, message, requestId } }`. Database
 * constraint failures become 4xx with a generic message (the constraint name goes to the log,
 * not the client); anything unexpected is a 500 with no internals.
 */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<AppRequest>();
    const res = ctx.getResponse<Response>();
    const body = this.toBody(exception, String(req.id ?? ''));
    res.status(body.error.status).json(body);
  }

  private toBody(exception: unknown, requestId: string): ErrorBody {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : typeof (response as { message?: unknown }).message === 'string'
            ? (response as { message: string }).message
            : exception.message;
      const details =
        typeof response === 'object' ? (response as { details?: unknown }).details : undefined;
      const code =
        (typeof response === 'object' && (response as { code?: string }).code) ||
        codeForStatus(status);
      return { error: { status, code, message, requestId, ...(details ? { details } : {}) } };
    }

    if (exception instanceof OptimisticLockVersionMismatchError) {
      return {
        error: {
          status: 409,
          code: 'stale_version',
          message: 'Someone else changed this first; reload and try again',
          requestId,
        },
      };
    }

    if (exception instanceof QueryFailedError) {
      const driver = exception.driverError as { code?: string; constraint?: string };
      const mapped = driver.code ? PG_ERRORS[driver.code] : undefined;
      if (mapped) {
        this.logger.warn(
          { requestId, sqlState: driver.code, constraint: driver.constraint },
          mapped.message,
        );
        return { error: { ...mapped, requestId } };
      }
    }

    this.logger.error({ requestId, err: exception }, 'unhandled error');
    return {
      error: {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'internal_error',
        message: 'Something went wrong',
        requestId,
      },
    };
  }
}

function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 422:
      return 'unprocessable';
    default:
      return status >= 500 ? 'internal_error' : 'error';
  }
}
