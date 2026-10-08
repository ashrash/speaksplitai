import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { remoteJwks } from '../auth/jwks.js';
import { checkToken, fetchDiscovery, printFindings } from './check-token.js';

/** Where the browser comes back to. Add it to the Native app's Allowed Callback URLs (dev tenant). */
export const LOGIN_REDIRECT_URI = 'http://localhost:3999/callback';

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Universal Login with Authorization Code + PKCE, the same flow the mobile app uses. */
export function authorizeUrl(p: {
  issuer: string;
  clientId: string;
  audience: string;
  challenge: string;
  state: string;
}): URL {
  const url = new URL('authorize', p.issuer);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: LOGIN_REDIRECT_URI,
    audience: p.audience,
    scope: 'openid profile email offline_access',
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
  }).toString();
  return url;
}

function waitForCode(state: string): Promise<string> {
  const { port, pathname } = new URL(LOGIN_REDIRECT_URI);
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', LOGIN_REDIRECT_URI);
      if (url.pathname !== pathname) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const fail = url.searchParams.get('error_description') ?? url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(code ? 'Signed in. You can close this tab.' : `Sign-in failed: ${fail}`);
      server.close();
      if (!code) reject(new Error(fail ?? 'No code in the callback'));
      else if (url.searchParams.get('state') !== state) reject(new Error('State mismatch'));
      else resolve(code);
    });
    server.listen(Number(port), '127.0.0.1');
  });
}

async function main(): Promise<void> {
  const {
    AUTH0_ISSUER_URL: issuer,
    AUTH0_AUDIENCE: audience,
    AUTH0_CLIENT_ID: clientId,
  } = process.env;
  if (!issuer || !audience || !clientId) {
    console.error('Set AUTH0_ISSUER_URL, AUTH0_AUDIENCE and AUTH0_CLIENT_ID (in .env).');
    process.exit(2);
  }
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString('base64url');
  console.log(
    `Open this URL and sign in:\n\n${authorizeUrl({ issuer, clientId, audience, challenge, state })}\n`,
  );
  const code = await waitForCode(state);

  const res = await fetch(new URL('oauth/token', issuer), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code_verifier: verifier,
      code,
      redirect_uri: LOGIN_REDIRECT_URI,
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== 'string') {
    console.error(
      `Token exchange failed: ${String(body.error_description ?? body.error ?? res.status)}`,
    );
    process.exit(1);
  }
  console.log(
    body.refresh_token
      ? '✓ Got a refresh token (offline access works)'
      : '! No refresh token: allow offline access on the API and the Refresh Token grant on the app',
  );
  const findings = await checkToken({
    token: body.access_token,
    issuer,
    audience,
    namespace: process.env.AUTH0_CLAIM_NAMESPACE || undefined,
    jwks: remoteJwks(issuer),
    discovery: await fetchDiscovery(issuer),
  });
  printFindings(findings);
  if (process.argv.includes('--print-token')) console.log(`\n${body.access_token}`);
  process.exit(findings.some((f) => f.level === 'error') ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
