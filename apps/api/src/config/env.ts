import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().optional(),
  AUTH0_ISSUER_URL: z.url().optional(),
  AUTH0_AUDIENCE: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Used by ConfigModule: fail fast at boot on a bad or missing variable. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
