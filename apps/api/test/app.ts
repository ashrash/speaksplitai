import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createMigratedDatabase, type TestDatabase } from './db.js';

export const ISSUER = 'https://login.test.local/';
export const AUDIENCE = 'https://api.speaksplit.test';
const KID = 'test-key';
type SigningKey = Parameters<SignJWT['sign']>[0];

export interface TestApp {
  app: INestApplication;
  db: TestDatabase;
  /** Signs an access token the way Auth0 would. */
  token(
    sub: string,
    claims?: JWTPayload,
    opts?: { audience?: string; issuer?: string; expiresIn?: string },
  ): Promise<string>;
  /** A token signed with a key the API doesn't trust. */
  foreignToken(sub: string): Promise<string>;
  close(): Promise<void>;
}

/** Boots the real AppModule against a fresh migrated database, trusting a local signing key. */
export async function createTestApp(): Promise<TestApp> {
  const db = await createMigratedDatabase();
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256' }],
  });

  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: db.url,
    AUTH0_ISSUER_URL: ISSUER,
    AUTH0_AUDIENCE: AUDIENCE,
  });
  // imported after the environment is set: ConfigModule validates it at import time
  const { AppModule } = await import('../src/app.module.js');
  const { JWKS } = await import('../src/auth/jwks.js');
  const { configureApp } = await import('../src/setup.js');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(JWKS)
    .useValue(jwks)
    .compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.init();

  const sign = (
    key: SigningKey,
    sub: string,
    claims: JWTPayload = {},
    opts: { audience?: string; issuer?: string; expiresIn?: string } = {},
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? '5m')
      .sign(key);

  return {
    app,
    db,
    token: (sub, claims, opts) => sign(privateKey, sub, claims, opts),
    foreignToken: (sub) => sign(foreign.privateKey, sub),
    async close() {
      await app.close();
      await db.drop();
    },
  };
}
