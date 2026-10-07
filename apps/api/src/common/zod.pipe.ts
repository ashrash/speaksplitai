import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Validates and parses a request body (or query) with a shared zod schema from api-types. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        code: 'invalid_request',
        message: 'The request is not valid',
        details: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}
