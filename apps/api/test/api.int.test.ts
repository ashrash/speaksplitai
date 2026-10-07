import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './app.js';

let t: TestApp;
let http: ReturnType<TestApp['app']['getHttpServer']>;
let asha: string; // tokens
let bala: string;

beforeAll(async () => {
  t = await createTestApp();
  http = t.app.getHttpServer();
  asha = await t.token('auth0|asha', { name: 'Asha' });
  bala = await t.token('google-oauth2|bala', { email: 'bala@example.com' });
});

afterAll(async () => {
  await t?.close();
});

const get = (path: string, token?: string) => {
  const r = request(http).get(path);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};
const createGroup = (token: string, body: object, key: string = randomUUID()) =>
  request(http)
    .post('/groups')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(body);

describe('authentication', () => {
  it('lets health checks through without a token', async () => {
    const res = await get('/health').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('rejects a missing token with the standard error body and a request id', async () => {
    const res = await get('/me').expect(401);
    expect(res.body.error).toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('echoes a well-formed X-Request-Id', async () => {
    const res = await get('/me').set('X-Request-Id', 'client-req-12345').expect(401);
    expect(res.headers['x-request-id']).toBe('client-req-12345');
  });

  it.each([
    ['the wrong audience', () => t.token('auth0|x', {}, { audience: 'https://someone-else' })],
    ['the wrong issuer', () => t.token('auth0|x', {}, { issuer: 'https://evil.example/' })],
    ['an expired token', () => t.token('auth0|x', {}, { expiresIn: '-1m' })],
    ['an untrusted signing key', () => t.foreignToken('auth0|x')],
    ['garbage', async () => 'not.a.jwt'],
  ])('rejects %s', async (_label, makeToken) => {
    await get('/me', await makeToken()).expect(401);
  });

  it('creates the user on their first request and returns the same user afterwards', async () => {
    const first = await get('/me', asha).expect(200);
    expect(first.body).toMatchObject({
      name: 'Asha',
      defaultCurrency: 'INR',
      locale: 'en-IN',
      email: null,
    });
    const second = await get('/me', asha).expect(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it('takes a display name from the email when the token has no name, without storing the email', async () => {
    const res = await get('/me', bala).expect(200);
    expect(res.body).toMatchObject({ name: 'bala', email: null });
  });

  it('creates exactly one user when several first requests arrive at once', async () => {
    const token = await t.token('auth0|burst', { name: 'Burst' });
    const results = await Promise.all(Array.from({ length: 5 }, () => get('/me', token)));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    const rows = await t.db.dataSource.query(
      `select count(*)::int as n from users where auth_subject = 'auth0|burst'`,
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('creating groups (idempotent)', () => {
  it('requires an Idempotency-Key', async () => {
    const res = await request(http)
      .post('/groups')
      .set('Authorization', `Bearer ${asha}`)
      .send({ name: 'Goa trip' })
      .expect(400);
    expect(res.body.error.code).toBe('idempotency_key_required');
  });

  it('creates the group with the caller as owner and writes the audit log', async () => {
    const res = await createGroup(asha, { name: 'Goa trip', type: 'trip' }).expect(201);
    expect(res.body).toMatchObject({
      name: 'Goa trip',
      type: 'trip',
      defaultCurrency: 'INR',
      simplifyDebts: true,
      version: 1,
      me: { role: 'owner', leftAt: null },
    });
    const audit = await t.db.dataSource.query(
      `select action, request_id from audit_log where entity = 'group' and entity_id = $1`,
      [res.body.id],
    );
    expect(audit).toEqual([{ action: 'create', request_id: res.headers['x-request-id'] }]);
  });

  it('replays the first response for a retry with the same key and body', async () => {
    const key = randomUUID();
    const body = { name: 'Flat 4B', type: 'flat', defaultCurrency: 'INR' };
    const first = await createGroup(asha, body, key).expect(201);
    const retry = await createGroup(
      asha,
      { defaultCurrency: 'INR', type: 'flat', name: 'Flat 4B' },
      key,
    ).expect(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);
    const rows = await t.db.dataSource.query(
      `select count(*)::int as n from groups where name = 'Flat 4B'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('rejects the same key with a different body', async () => {
    const key = randomUUID();
    await createGroup(asha, { name: 'One' }, key).expect(201);
    const res = await createGroup(asha, { name: 'Two' }, key).expect(422);
    expect(res.body.error.code).toBe('idempotency_key_reused');
  });

  it('keeps keys per user', async () => {
    const key = randomUUID();
    const a = await createGroup(asha, { name: 'Shared key' }, key).expect(201);
    const b = await createGroup(bala, { name: 'Shared key' }, key).expect(201);
    expect(b.body.id).not.toBe(a.body.id);
  });

  it('releases the key when the request fails, so a corrected retry works', async () => {
    const key = randomUUID();
    await createGroup(asha, { name: '' }, key).expect(400);
    await createGroup(asha, { name: 'Fixed' }, key).expect(201);
  });

  it('validates the body with the shared schema', async () => {
    const res = await createGroup(asha, { name: 'Trip', defaultCurrency: 'XYZ' }).expect(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(res.body.error.details).toEqual([expect.objectContaining({ path: 'defaultCurrency' })]);
  });
});

describe('group access', () => {
  let groupId: string;

  beforeAll(async () => {
    groupId = (await createGroup(asha, { name: 'Private', type: 'friends' }).expect(201)).body.id;
  });

  it('shows the owner their group', async () => {
    const res = await get(`/groups/${groupId}`, asha).expect(200);
    expect(res.body.members).toEqual([expect.objectContaining({ name: 'Asha', role: 'owner' })]);
    const list = await get('/groups', asha).expect(200);
    expect(list.body.map((g: { id: string }) => g.id)).toContain(groupId);
  });

  it('hides another group completely from a non-member (404, not 403)', async () => {
    await get(`/groups/${groupId}`, bala).expect(404);
    await request(http)
      .patch(`/groups/${groupId}`)
      .set('Authorization', `Bearer ${bala}`)
      .send({ version: 1, name: 'Hacked' })
      .expect(404);
    const list = await get('/groups', bala).expect(200);
    expect(list.body.map((g: { id: string }) => g.id)).not.toContain(groupId);
  });

  it('returns 404 for ids that are not UUIDs', async () => {
    await get('/groups/not-a-uuid', asha).expect(404);
  });

  it('gives a former member read-only access', async () => {
    const balaId = (await get('/me', bala).expect(200)).body.id;
    await t.db.dataSource.query(
      `insert into group_members (group_id, user_id, role, joined_at, left_at)
       values ($1, $2, 'member', now() - interval '1 day', now())`,
      [groupId, balaId],
    );
    const res = await get(`/groups/${groupId}`, bala).expect(200);
    expect(res.body.me.leftAt).not.toBeNull();
    const patch = await request(http)
      .patch(`/groups/${groupId}`)
      .set('Authorization', `Bearer ${bala}`)
      .send({ version: 1, name: 'Renamed by leaver' })
      .expect(403);
    expect(patch.body.error.code).toBe('forbidden');
    // a group you've left drops off your list but stays readable by id
    const list = await get('/groups', bala).expect(200);
    expect(list.body.map((g: { id: string }) => g.id)).not.toContain(groupId);
  });

  it('uses optimistic locking: a stale version gets 409', async () => {
    const patch = (version: number, name: string) =>
      request(http)
        .patch(`/groups/${groupId}`)
        .set('Authorization', `Bearer ${asha}`)
        .send({ version, name });
    const ok = await patch(1, 'Private v2').expect(200);
    expect(ok.body).toMatchObject({ name: 'Private v2', version: 2 });
    const stale = await patch(1, 'Lost update').expect(409);
    expect(stale.body.error.code).toBe('stale_version');
    expect((await get(`/groups/${groupId}`, asha)).body.name).toBe('Private v2');
  });

  it('blocks writes to an archived group', async () => {
    const id = (await createGroup(asha, { name: 'Old trip' }).expect(201)).body.id;
    await t.db.dataSource.query('update groups set archived_at = now() where id = $1', [id]);
    const res = await request(http)
      .patch(`/groups/${id}`)
      .set('Authorization', `Bearer ${asha}`)
      .send({ version: 1, name: 'Nope' })
      .expect(409);
    expect(res.body.error.code).toBe('archived');
    await get(`/groups/${id}`, asha).expect(200);
  });
});
