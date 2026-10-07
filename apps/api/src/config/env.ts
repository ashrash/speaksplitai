import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().optional(),
  /** Auth0 tenant (or custom domain) with trailing slash, e.g. https://login.example.com/ */
  AUTH0_ISSUER_URL: z.url(),
  /** The API identifier configured in Auth0; access tokens must carry it in `aud`. */
  AUTH0_AUDIENCE: z.string().min(1),
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
