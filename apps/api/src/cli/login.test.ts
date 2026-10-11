import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authorizeUrl, LOGIN_REDIRECT_URI, pkce } from './login.js';

describe('auth:login', () => {
  it('makes an S256 PKCE pair', () => {
    const { verifier, challenge } = pkce();
    expect(verifier).toMatch(/^[\w-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('asks Universal Login for an API token with offline access', () => {
    const url = authorizeUrl({
      issuer: 'https://tenant.eu.auth0.com/',
      clientId: 'cid',
      audience: 'https://api.speaksplit.example.com',
      challenge: 'ch',
      state: 'st',
    });
    expect(url.origin + url.pathname).toBe('https://tenant.eu.auth0.com/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'cid',
      redirect_uri: LOGIN_REDIRECT_URI,
      audience: 'https://api.speaksplit.example.com',
      scope: 'openid profile email offline_access',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      state: 'st',
    });
  });
});
