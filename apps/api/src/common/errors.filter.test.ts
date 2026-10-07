import { type ArgumentsHost, ConflictException, NotFoundException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { ErrorsFilter } from './errors.filter.js';

function run(exception: unknown) {
  const json = vi.fn((_body: { error: Record<string, unknown> }) => undefined);
  const status = vi.fn((_code: number) => ({ json }));
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: 'req-1' }),
      getResponse: () => ({ status }),
    }),
  } as unknown as ArgumentsHost;
  new ErrorsFilter().catch(exception, host);
  const body = json.mock.calls[0]?.[0];
  if (!body) throw new Error('filter did not send a body');
  return { status: status.mock.calls[0]?.[0], body };
}

const pgError = (code: string) =>
  new QueryFailedError(
    'insert ...',
    [],
    Object.assign(new Error('pg'), { code, constraint: 'some_ck' }),
  );

describe('ErrorsFilter', () => {
  it.each([
    ['23514', 422, 'constraint_violation'],
    ['23503', 422, 'reference_not_found'],
    ['23505', 409, 'conflict'],
    ['23001', 409, 'restricted'],
    ['40001', 409, 'retry'],
  ])('maps SQLSTATE %s to %s', (code, httpStatus, errorCode) => {
    const { status, body } = run(pgError(code));
    expect(status).toBe(httpStatus);
    expect(body.error).toMatchObject({ status: httpStatus, code: errorCode, requestId: 'req-1' });
    expect(JSON.stringify(body)).not.toContain('some_ck'); // constraint names stay in the log
  });

  it('passes HTTP exceptions through with their code', () => {
    expect(run(new NotFoundException('Group not found')).body.error).toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'Group not found',
    });
    expect(
      run(new ConflictException({ code: 'archived', message: 'Archived' })).body.error.code,
    ).toBe('archived');
  });

  it('hides unexpected errors behind a generic 500', () => {
    const { status, body } = run(new Error('connection string with password'));
    expect(status).toBe(500);
    expect(body.error).toEqual({
      status: 500,
      code: 'internal_error',
      message: 'Something went wrong',
      requestId: 'req-1',
    });
  });
});
