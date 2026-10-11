import { pathToFileURL } from 'node:url';
import {
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { readClaim } from '../auth/claims.js';
import { remoteJwks } from '../auth/jwks.js';

export interface Finding {
  level: 'ok' | 'warn' | 'error';
  message: string;
}

export interface CheckTokenInput {
  token: string;
  issuer: string;
  audience: string;
  namespace?: string;
  jwks: JWTVerifyGetKey;
  /** The tenant's OpenID configuration; null when it couldn't be fetched. */
  discovery: { issuer?: unknown } | null;
  now?: Date;
}

/**
 * Checks an Auth0 access token the way the API's AuthGuard does, but explains each failure in
 * terms of the tenant setup (deploy/auth0/README.md) instead of a bare 401.
 */
export async function checkToken(input: CheckTokenInput): Promise<Finding[]> {
  const findings: Finding[] = [];
  const ok = (message: string) => findings.push({ level: 'ok', message });
  const warn = (message: string) => findings.push({ level: 'warn', message });
  const error = (message: string) => findings.push({ level: 'error', message });

  if (!input.issuer.endsWith('/')) {
    error(`AUTH0_ISSUER_URL must end with a slash: ${input.issuer}/`);
  }
  if (input.discovery === null) {
    error(`Couldn't fetch ${input.issuer}.well-known/openid-configuration: check AUTH0_ISSUER_URL`);
  } else if (input.discovery.issuer !== input.issuer) {
    error(
      `The tenant's issuer is ${String(input.discovery.issuer)} but AUTH0_ISSUER_URL is ${input.issuer}`,
    );
  } else {
    ok(`AUTH0_ISSUER_URL matches the tenant (${input.issuer})`);
  }

  const parts = input.token.trim().split('.');
  if (parts.length === 5) {
    error(
      "This is an encrypted (JWE) token, which the API can't read: sign in with audience=" +
        `${input.audience}, and turn off "JSON Web Encryption" on the Auth0 API`,
    );
    return findings;
  }
  if (parts.length !== 3) {
    error(
      `This isn't a JWT (Auth0 returns an opaque token when no audience is requested): sign in with audience=${input.audience}`,
    );
    return findings;
  }

  let payload: JWTPayload;
  try {
    const header = decodeProtectedHeader(input.token);
    if (header.alg !== 'RS256') {
      error(`Signed with ${String(header.alg)}; set the Auth0 API's signing algorithm to RS256`);
    }
    payload = decodeJwt(input.token);
  } catch {
    error("The token can't be decoded");
    return findings;
  }

  if (payload.iss !== input.issuer) {
    error(`Issued by ${String(payload.iss)}, but the API expects ${input.issuer}`);
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(input.audience)) {
    error(
      `Issued for ${audiences.filter(Boolean).join(', ') || 'no audience'}, but the API expects ` +
        `${input.audience}: pass audience=${input.audience} when signing in`,
    );
  }
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (typeof payload.exp === 'number' && payload.exp <= now) {
    error(`Expired at ${new Date(payload.exp * 1000).toISOString()}: get a fresh token`);
  }
  if (findings.some((f) => f.level === 'error')) return findings;

  try {
    await jwtVerify(input.token, input.jwks, {
      issuer: input.issuer,
      audience: input.audience,
      algorithms: ['RS256'],
      currentDate: input.now,
    });
    ok(`Signature, issuer, audience and expiry are valid (sub ${String(payload.sub)})`);
  } catch (e) {
    error(`Verification failed: ${(e as Error).message}`);
    return findings;
  }

  checkProfileClaims(payload, input.namespace, { ok, warn });
  return findings;
}

function checkProfileClaims(
  payload: JWTPayload,
  namespace: string | undefined,
  { ok, warn }: Record<'ok' | 'warn', (message: string) => void>,
): void {
  const email = readClaim(payload, namespace, 'email');
  if (typeof email !== 'string') {
    const elsewhere = Object.keys(payload).find((k) => k !== 'email' && k.endsWith('/email'));
    warn(
      elsewhere
        ? `Found ${elsewhere}, but AUTH0_CLAIM_NAMESPACE is ${namespace ?? 'not set'}: ` +
            `set it to ${elsewhere.slice(0, -'email'.length)}`
        : 'No email claim: deploy the post-login Action and set its CLAIM_NAMESPACE secret to AUTH0_CLAIM_NAMESPACE',
    );
    return;
  }
  if (readClaim(payload, namespace, 'email_verified') === true) {
    ok(`Verified email ${email}: friend requests by email will reach this user`);
  } else {
    warn(
      `Email ${email} isn't verified, so the API won't save it (friend requests by email won't match)`,
    );
  }
  const name = readClaim(payload, namespace, 'name');
  if (typeof name === 'string') ok(`Name ${name}`);
  else warn("No name claim: new users are named after their email's local part");
}

export async function fetchDiscovery(issuer: string): Promise<{ issuer?: unknown } | null> {
  try {
    const res = await fetch(new URL('.well-known/openid-configuration', issuer));
    return res.ok ? ((await res.json()) as { issuer?: unknown }) : null;
  } catch {
    return null;
  }
}

export function printFindings(findings: Finding[]): void {
  const mark = { ok: '✓', warn: '!', error: '✗' } as const;
  for (const f of findings) console.log(`${mark[f.level]} ${f.message}`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const { AUTH0_ISSUER_URL: issuer, AUTH0_AUDIENCE: audience } = process.env;
  if (!issuer || !audience) {
    console.error('Set AUTH0_ISSUER_URL and AUTH0_AUDIENCE (in .env or the environment).');
    process.exit(2);
  }
  const token = (process.argv[2] ?? (process.stdin.isTTY ? '' : await readStdin())).trim();
  if (!token) {
    console.error(
      'Usage: pnpm --filter @speaksplit/api auth:check-token <access token>  (or pipe it in)',
    );
    process.exit(2);
  }
  const findings = await checkToken({
    token,
    issuer,
    audience,
    namespace: process.env.AUTH0_CLAIM_NAMESPACE || undefined,
    jwks: remoteJwks(issuer),
    discovery: await fetchDiscovery(issuer),
  });
  printFindings(findings);
  process.exit(findings.some((f) => f.level === 'error') ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
