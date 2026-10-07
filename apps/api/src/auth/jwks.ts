import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';

/** Injection token for the key set used to verify access tokens (overridden in tests). */
export const JWKS = Symbol('JWKS');

export function remoteJwks(issuerUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL('.well-known/jwks.json', issuerUrl));
}
