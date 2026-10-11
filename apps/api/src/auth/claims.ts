import type { JWTPayload } from 'jose';

/**
 * Reads a profile claim from an access token: the plain claim if present, otherwise the one the
 * Auth0 post-login Action (deploy/auth0/post-login.js) sets under the namespace. A namespace
 * without a trailing slash is treated as if it had one, the same way the Action treats it.
 */
export function readClaim(
  claims: JWTPayload,
  namespace: string | undefined,
  name: string,
): unknown {
  if (claims[name] !== undefined) return claims[name];
  if (!namespace) return undefined;
  const ns = namespace.endsWith('/') ? namespace : `${namespace}/`;
  return claims[`${ns}${name}`];
}

/** The name a new user starts with: name, nickname or given name, else the email's local part. */
export function displayName(claims: JWTPayload, namespace: string | undefined): string {
  for (const key of ['name', 'nickname', 'given_name']) {
    const value = readClaim(claims, namespace, key);
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 80);
  }
  const email = readClaim(claims, namespace, 'email');
  if (typeof email === 'string' && email.includes('@')) return email.split('@')[0]!.slice(0, 80);
  return 'New user';
}
