import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './app.js';

let t: TestApp;
let http: ReturnType<TestApp['app']['getHttpServer']>;
let asha: string;
let bala: string;

beforeAll(async () => {
  t = await createTestApp();
  http = t.app.getHttpServer();
  asha = await t.token('auth0|asha', { name: 'Asha' });
  bala = await t.token('auth0|bala', { name: 'Bala' });
});

afterAll(async () => {
  await t?.close();
});

const as = (token: string) => ({
  get: (path: string) => request(http).get(path).set('Authorization', `Bearer ${token}`),
  post: (path: string, body: object) =>
    request(http).post(path).set('Authorization', `Bearer ${token}`).send(body),
  patch: (path: string, body: object) =>
    request(http).patch(path).set('Authorization', `Bearer ${token}`).send(body),
  del: (path: string) => request(http).delete(path).set('Authorization', `Bearer ${token}`),
});

describe('profile', () => {
  it('starts with defaults and no UPI IDs', async () => {
    const res = await as(asha).get('/me').expect(200);
    expect(res.body).toMatchObject({
      name: 'Asha',
      locale: 'en-IN',
      defaultCurrency: 'INR',
      upiIds: [],
    });
  });

  it('updates name, avatar, language and default currency', async () => {
    const res = await as(asha)
      .patch('/me', {
        name: '  Asha R  ',
        avatarUrl: 'https://cdn.example.com/a.png',
        locale: 'hi',
        defaultCurrency: 'USD',
      })
      .expect(200);
    expect(res.body).toMatchObject({
      name: 'Asha R',
      avatarUrl: 'https://cdn.example.com/a.png',
      locale: 'hi',
      defaultCurrency: 'USD',
    });
    await as(asha).patch('/me', { avatarUrl: null }).expect(200);
    expect((await as(asha).get('/me')).body.avatarUrl).toBeNull();
  });

  it.each([
    ['an empty name', { name: '   ' }],
    ['a plain-http avatar', { avatarUrl: 'http://cdn.example.com/a.png' }],
    ['an unknown currency', { defaultCurrency: 'XYZ' }],
    ['a malformed language', { locale: 'english' }],
    ['nothing at all', {}],
  ])('rejects %s', async (_label, body) => {
    const res = await as(asha).patch('/me', body).expect(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('ignores fields it does not allow, such as email', async () => {
    await as(asha).patch('/me', { name: 'Asha', email: 'someone@else.com' }).expect(200);
    expect((await as(asha).get('/me')).body.email).toBeNull();
  });
});

describe('UPI IDs', () => {
  it('makes the first UPI ID primary', async () => {
    const res = await as(bala)
      .post('/me/upi-ids', { vpa: 'bala@okaxis', label: 'Axis' })
      .expect(201);
    expect(res.body).toMatchObject({ vpa: 'bala@okaxis', label: 'Axis', isPrimary: true });
  });

  it('adds later ones as non-primary unless asked', async () => {
    const second = await as(bala).post('/me/upi-ids', { vpa: 'bala@ybl' }).expect(201);
    expect(second.body.isPrimary).toBe(false);
    const list = (await as(bala).get('/me/upi-ids').expect(200)).body;
    expect(list.map((u: { vpa: string }) => u.vpa)).toEqual(['bala@okaxis', 'bala@ybl']);
  });

  it('rejects a duplicate regardless of case, and invalid UPI IDs', async () => {
    const dup = await as(bala).post('/me/upi-ids', { vpa: 'BALA@okaxis' }).expect(409);
    expect(dup.body.error.code).toBe('conflict');
    const bad = await as(bala).post('/me/upi-ids', { vpa: 'not a upi id' }).expect(400);
    expect(bad.body.error.details[0].path).toBe('vpa');
  });

  it('moves primary to another UPI ID, keeping exactly one primary', async () => {
    const list = (await as(bala).get('/me/upi-ids')).body as Array<{ id: string; vpa: string }>;
    const ybl = list.find((u) => u.vpa === 'bala@ybl')!;
    const res = await as(bala)
      .patch(`/me/upi-ids/${ybl.id}`, { isPrimary: true, label: 'PhonePe' })
      .expect(200);
    expect(res.body).toMatchObject({ isPrimary: true, label: 'PhonePe' });
    const after = (await as(bala).get('/me')).body.upiIds;
    expect(after.filter((u: { isPrimary: boolean }) => u.isPrimary)).toHaveLength(1);
    expect(after[0].vpa).toBe('bala@ybl'); // primary listed first
  });

  it('handles simultaneous "make primary" requests without errors or a second primary', async () => {
    const token = await t.token('auth0|racer', { name: 'Racer' });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++)
      ids.push((await as(token).post('/me/upi-ids', { vpa: `racer${i}@okaxis` })).body.id);
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        as(token).patch(`/me/upi-ids/${ids[i % ids.length]}`, { isPrimary: true }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(results.map(() => 200));
    const after = (await as(token).get('/me')).body.upiIds;
    expect(after.filter((u: { isPrimary: boolean }) => u.isPrimary)).toHaveLength(1);
  });

  it('promotes the oldest remaining UPI ID when the primary is removed', async () => {
    await as(bala).post('/me/upi-ids', { vpa: 'bala@paytm' }).expect(201);
    const before = (await as(bala).get('/me')).body.upiIds as Array<{
      id: string;
      vpa: string;
      isPrimary: boolean;
    }>;
    const primary = before.find((u) => u.isPrimary)!;
    await as(bala).del(`/me/upi-ids/${primary.id}`).expect(204);
    const after = (await as(bala).get('/me')).body.upiIds as Array<{
      vpa: string;
      isPrimary: boolean;
    }>;
    expect(after).toHaveLength(2);
    const expected = ['bala@okaxis', 'bala@ybl', 'bala@paytm'].find(
      (v) => v !== primary.vpa && after.some((u) => u.vpa === v),
    );
    expect(after.find((u) => u.isPrimary)?.vpa).toBe(expected);
  });

  it("hides other people's UPI IDs (404)", async () => {
    const balaId = (await as(bala).get('/me')).body.upiIds[0].id;
    await as(asha).patch(`/me/upi-ids/${balaId}`, { label: 'mine now' }).expect(404);
    await as(asha).del(`/me/upi-ids/${balaId}`).expect(404);
    await as(asha).del('/me/upi-ids/not-a-uuid').expect(404);
  });

  it('caps the number of UPI IDs', async () => {
    const token = await t.token('auth0|collector', { name: 'Collector' });
    for (let i = 0; i < 10; i++)
      await as(token)
        .post('/me/upi-ids', { vpa: `c${i}@okaxis` })
        .expect(201);
    const res = await as(token).post('/me/upi-ids', { vpa: 'c10@okaxis' }).expect(409);
    expect(res.body.error.code).toBe('limit');
  });
});
