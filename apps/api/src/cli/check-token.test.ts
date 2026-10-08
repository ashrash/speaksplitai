import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkToken, type CheckTokenInput } from './check-token.js';

const ISSUER = 'https://tenant.eu.auth0.com/';
const AUDIENCE = 'https://api.speaksplit.example.com';
const NS = 'https://speaksplit.example.com/';

let key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let jwks: CheckTokenInput['jwks'];

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  key = pair.privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1' }] });
});

function sign(claims: JWTPayload = {}, opts: { iss?: string; aud?: string; exp?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject('auth0|abc')
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '1h')
    .sign(key);
}

async function check(token: string, overrides: Partial<CheckTokenInput> = {}) {
  const findings = await checkToken({
    token,
    issuer: ISSUER,
    audience: AUDIENCE,
    namespace: NS,
    jwks,
    discovery: { issuer: ISSUER },
    ...overrides,
  });
  return {
    errors: findings.filter((f) => f.level === 'error').map((f) => f.message),
    warnings: findings.filter((f) => f.level === 'warn').map((f) => f.message),
    oks: findings.filter((f) => f.level === 'ok').map((f) => f.message),
  };
}

const PROFILE = {
  [`${NS}email`]: 'asha@example.com',
  [`${NS}email_verified`]: true,
  [`${NS}name`]: 'Asha',
};

describe('checkToken', () => {
  it('passes a token set up as the guide describes', async () => {
    const r = await check(await sign(PROFILE));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.oks.join('\n')).toMatch(/Signature, issuer, audience and expiry are valid/);
    expect(r.oks.join('\n')).toMatch(/Verified email asha@example.com/);
  });

  it('explains a wrong audience', async () => {
    const r = await check(await sign(PROFILE, { aud: 'https://tenant.eu.auth0.com/userinfo' }));
    expect(r.errors.join('\n')).toMatch(/pass audience=https:\/\/api\.speaksplit\.example\.com/);
  });

  it('explains an opaque or encrypted token', async () => {
    expect((await check('abc123')).errors.join('\n')).toMatch(/isn't a JWT/);
    expect((await check('a.b.c.d.e')).errors.join('\n')).toMatch(/encrypted \(JWE\)/);
  });

  it('catches an issuer without its trailing slash, or another tenant', async () => {
    const noSlash = await check(await sign(PROFILE), { issuer: ISSUER.slice(0, -1) });
    expect(noSlash.errors.join('\n')).toMatch(/must end with a slash/);

    const other = await check(await sign(PROFILE, { iss: 'https://other.us.auth0.com/' }));
    expect(other.errors.join('\n')).toMatch(/Issued by https:\/\/other\.us\.auth0\.com\//);

    const unreachable = await check(await sign(PROFILE), { discovery: null });
    expect(unreachable.errors.join('\n')).toMatch(/Couldn't fetch/);
  });

  it('reports an expired token', async () => {
    const r = await check(await sign(PROFILE, { exp: '1s' }), {
      now: new Date(Date.now() + 60_000),
    });
    expect(r.errors.join('\n')).toMatch(/Expired at/);
  });

  it('rejects a token signed by another key', async () => {
    const other = await generateKeyPair('RS256');
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('1h')
      .sign(other.privateKey);
    expect((await check(token)).errors.join('\n')).toMatch(/Verification failed/);
  });

  it('warns when the Action is missing or uses another namespace', async () => {
    const none = await check(await sign());
    expect(none.warnings.join('\n')).toMatch(/deploy the post-login Action/);

    const other = await check(await sign({ 'https://elsewhere.io/email': 'a@x.io' }));
    expect(other.warnings.join('\n')).toMatch(/set it to https:\/\/elsewhere\.io\//);
  });

  it('warns about an unverified email', async () => {
    const r = await check(await sign({ ...PROFILE, [`${NS}email_verified`]: false }));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/isn't verified/);
  });
});
