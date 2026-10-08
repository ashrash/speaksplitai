import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { displayName, readClaim } from './claims.js';

type Claims = Record<string, unknown>;
type Action = {
  onExecutePostLogin: (
    event: { user: Record<string, unknown>; secrets: Record<string, string> },
    api: unknown,
  ) => Promise<void>;
};

const { onExecutePostLogin } = createRequire(import.meta.url)(
  '../../../../deploy/auth0/post-login.js',
) as Action;

const NS = 'https://speaksplit.example.com/';

async function runAction(user: Record<string, unknown>, secrets: Record<string, string> = {}) {
  const claims: Claims = {};
  const denied: string[] = [];
  const api = {
    accessToken: { setCustomClaim: (k: string, v: unknown) => (claims[k] = v) },
    access: { deny: (reason: string) => denied.push(reason) },
  };
  await onExecutePostLogin({ user, secrets: { CLAIM_NAMESPACE: NS, ...secrets } }, api);
  return { claims, denied };
}

describe('Auth0 post-login Action', () => {
  it('adds namespaced email, email_verified and name that the API reads', async () => {
    const { claims } = await runAction({
      email: 'asha@example.com',
      email_verified: true,
      name: 'Asha Rao',
    });
    expect(claims).toEqual({
      [`${NS}email`]: 'asha@example.com',
      [`${NS}email_verified`]: true,
      [`${NS}name`]: 'Asha Rao',
    });
    expect(readClaim(claims, NS, 'email')).toBe('asha@example.com');
    expect(readClaim(claims, NS, 'email_verified')).toBe(true);
    expect(displayName(claims, NS)).toBe('Asha Rao');
  });

  it('marks an unverified email as unverified', async () => {
    const { claims } = await runAction({ email: 'x@example.com' });
    expect(claims[`${NS}email_verified`]).toBe(false);
  });

  it('skips the name when Auth0 just copied the email into it (passwordless)', async () => {
    const { claims } = await runAction({
      email: 'ravi@example.com',
      email_verified: true,
      name: 'ravi@example.com',
      nickname: 'ravi',
    });
    expect(claims[`${NS}name`]).toBe('ravi');

    const bare = await runAction({ email: 'ravi@example.com', name: 'ravi@example.com' });
    expect(bare.claims[`${NS}name`]).toBeUndefined();
    expect(displayName(bare.claims, NS)).toBe('ravi');
  });

  it('adds the trailing slash to the namespace, and the API reads it either way', async () => {
    const { claims } = await runAction(
      { email: 'a@example.com', email_verified: true },
      { CLAIM_NAMESPACE: 'https://speaksplit.example.com' },
    );
    expect(claims[`${NS}email`]).toBe('a@example.com');
    expect(readClaim(claims, 'https://speaksplit.example.com', 'email')).toBe('a@example.com');
  });

  it('adds no email claims for a user without email (e.g. phone sign-in)', async () => {
    const { claims } = await runAction({ phone_number: '+919800000000' });
    expect(claims).toEqual({});
  });

  it('denies sign-in when the namespace secret is missing', async () => {
    const { claims, denied } = await runAction({ email: 'a@example.com' }, { CLAIM_NAMESPACE: '' });
    expect(denied).toHaveLength(1);
    expect(claims).toEqual({});
  });
});

describe('readClaim', () => {
  it('prefers the plain claim over the namespaced one', () => {
    expect(readClaim({ email: 'a@x.io', [`${NS}email`]: 'b@x.io' }, NS, 'email')).toBe('a@x.io');
  });

  it('ignores namespaced claims when no namespace is configured', () => {
    expect(readClaim({ [`${NS}email`]: 'b@x.io' }, undefined, 'email')).toBeUndefined();
  });
});
