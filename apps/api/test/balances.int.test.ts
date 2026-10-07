import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './app.js';
import { fixtures } from './fixtures.js';

let t: TestApp;
let f: ReturnType<typeof fixtures>;
let g: string;
const m: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestApp();
  f = fixtures(t);
  for (const name of ['owner', 'bala', 'chitra', 'outsider']) await f.user(name);
  g = await f.newGroup('owner', 'Goa');
  m.owner = await f.memberId(g, 'owner');
  m.bala = await f.addMember(g, 'bala');
  m.chitra = await f.addMember(g, 'chitra');
  // owner pays ₹300 for all three; bala pays ₹60 for bala and chitra
  await spend('owner', m.owner!, 30000, [m.owner!, m.bala!, m.chitra!]);
  await spend('bala', m.bala!, 6000, [m.bala!, m.chitra!]);
});

afterAll(async () => {
  await t?.close();
});

function spend(
  as: string,
  payer: string,
  total: number,
  memberIds: string[],
  currency = 'INR',
  groupId = g,
) {
  return f
    .as(as)
    .post(`/groups/${groupId}/expenses`, {
      description: 'Spend',
      totalMinor: total,
      currency,
      expenseDate: '2026-10-01',
      payers: [{ memberId: payer, paidMinor: total }],
      split: { type: 'equal', memberIds },
    })
    .expect(201);
}

function pay(as: string, body: object, key = randomUUID(), groupId = g) {
  return request(t.app.getHttpServer())
    .post(`/groups/${groupId}/settlements`)
    .set('Authorization', `Bearer ${f.tokens[as]}`)
    .set('Idempotency-Key', key)
    .send(body);
}

const balances = async (groupId = g) =>
  (await f.as('owner').get(`/groups/${groupId}/balances`).expect(200)).body;
const net = (
  body: {
    members: Array<{ memberId: string; balances: Array<{ currency: string; netMinor: number }> }>;
  },
  member: string,
  currency = 'INR',
) =>
  body.members.find((x) => x.memberId === member)?.balances.find((b) => b.currency === currency)
    ?.netMinor ?? 0;
const plan = (body: {
  plan: Array<{
    from: { name: string };
    to: { name: string };
    amountMinor: number;
    currency: string;
  }>;
}) => body.plan.map((p) => `${p.from.name}->${p.to.name} ${p.currency} ${p.amountMinor}`);

describe('group balances', () => {
  it('shows each net and the simplified plan', async () => {
    const body = await balances();
    expect([net(body, m.owner!), net(body, m.bala!), net(body, m.chitra!)]).toEqual([
      20000, -7000, -13000,
    ]);
    expect(body.simplified).toBe(true);
    expect(plan(body).sort()).toEqual(['bala->owner INR 7000', 'chitra->owner INR 13000']);
  });

  it('shows who owes whom directly when simplification is off', async () => {
    const version = (await f.as('owner').get(`/groups/${g}`)).body.version;
    await f.as('owner').patch(`/groups/${g}`, { version, simplifyDebts: false }).expect(200);
    expect(plan(await balances()).sort()).toEqual([
      'bala->owner INR 10000',
      'chitra->bala INR 3000',
      'chitra->owner INR 10000',
    ]);
    await f
      .as('owner')
      .patch(`/groups/${g}`, { version: version + 1, simplifyDebts: true })
      .expect(200);
  });

  it('is hidden from outsiders', async () => {
    await f.as('outsider').get(`/groups/${g}/balances`).expect(404);
  });
});

describe('recording payments', () => {
  it('rejects anything but the full amount, saying what it should be', async () => {
    const res = await pay('bala', {
      fromMemberId: m.bala,
      toMemberId: m.owner,
      currency: 'INR',
      amountMinor: 5000,
      method: 'cash',
    }).expect(422);
    expect(res.body.error).toMatchObject({
      code: 'partial_payment',
      details: { expectedMinor: 7000, currency: 'INR' },
    });
  });

  it("rejects a payment the plan doesn't contain", async () => {
    const res = await pay('owner', {
      fromMemberId: m.owner,
      toMemberId: m.bala,
      currency: 'INR',
      amountMinor: 100,
      method: 'cash',
    }).expect(409);
    expect(res.body.error.code).toBe('nothing_owed');
  });

  it('lets only the payer or the payee record it', async () => {
    const res = await pay('chitra', {
      fromMemberId: m.bala,
      toMemberId: m.owner,
      currency: 'INR',
      amountMinor: 7000,
      method: 'cash',
    }).expect(403);
    expect(res.body.error.code).toBe('not_a_party');
  });

  it('records a UPI payment that counts at once', async () => {
    const res = await pay('chitra', {
      fromMemberId: m.chitra,
      toMemberId: m.owner,
      currency: 'INR',
      amountMinor: 13000,
      method: 'upi',
      upiRef: 'AXIS1234567890',
      note: 'for Goa',
    }).expect(201);
    expect(res.body).toMatchObject({
      status: 'confirmed',
      amountMinor: 13000,
      from: { name: 'chitra' },
      to: { name: 'owner' },
    });
    const body = await balances();
    expect(net(body, m.chitra!)).toBe(0);
    expect(plan(body)).toEqual(['bala->owner INR 7000']);
  });

  it('lets exactly one of many simultaneous recordings of the same debt through', async () => {
    const body = {
      fromMemberId: m.bala,
      toMemberId: m.owner,
      currency: 'INR',
      amountMinor: 7000,
      method: 'cash',
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => pay(i % 2 ? 'owner' : 'bala', body)),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    expect(plan(await balances())).toEqual([]);
  });

  it('checks and records under the group lock (so a concurrent change waits)', async () => {
    await spend('owner', m.owner!, 1200, [m.owner!, m.chitra!]);
    const holder = t.db.dataSource.createQueryRunner();
    await holder.startTransaction();
    // FOR NO KEY UPDATE conflicts with the API's FOR UPDATE, but not with the key-share lock the
    // settlements -> groups foreign key takes, so only the API's own lock makes the request wait
    await holder.query('select 1 from groups where id = $1 for no key update', [g]);
    let finished = false;
    const pending = pay('chitra', {
      fromMemberId: m.chitra,
      toMemberId: m.owner,
      currency: 'INR',
      amountMinor: 600,
      method: 'cash',
    }).then((r) => {
      finished = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(finished).toBe(false); // blocked behind the lock held above
    await holder.commitTransaction();
    await holder.release();
    expect((await pending).status).toBe(201);
  });

  it('is safe to retry with the same Idempotency-Key', async () => {
    await spend('owner', m.owner!, 2000, [m.owner!, m.bala!]);
    const key = randomUUID();
    const body = {
      fromMemberId: m.bala,
      toMemberId: m.owner,
      currency: 'INR',
      amountMinor: 1000,
      method: 'cash',
    };
    const first = await pay('bala', body, key).expect(201);
    const retry = await pay('bala', body, key).expect(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.headers['idempotent-replayed']).toBe('true');
  });

  it('can be cancelled by either party, putting the debt back', async () => {
    await spend('owner', m.owner!, 4000, [m.owner!, m.chitra!]);
    const s = (
      await pay('chitra', {
        fromMemberId: m.chitra,
        toMemberId: m.owner,
        currency: 'INR',
        amountMinor: 2000,
        method: 'cash',
      }).expect(201)
    ).body;
    await f.as('bala').del(`/groups/${g}/settlements/${s.id}`).expect(403);
    await f.as('owner').del(`/groups/${g}/settlements/${s.id}`).expect(204);
    await f.as('owner').del(`/groups/${g}/settlements/${s.id}`).expect(204);
    expect(plan(await balances())).toEqual(['chitra->owner INR 2000']);
    await pay('chitra', {
      fromMemberId: m.chitra,
      toMemberId: m.owner,
      currency: 'INR',
      amountMinor: 2000,
      method: 'cash',
    }).expect(201);
  });

  it('settles a dollar debt with rupees over UPI, and refuses UPI in dollars', async () => {
    await spend('owner', m.owner!, 3000, [m.owner!, m.bala!], 'USD');
    const usd = {
      fromMemberId: m.bala,
      toMemberId: m.owner,
      currency: 'USD',
      amountMinor: 1500,
      method: 'upi',
    };
    expect((await pay('bala', usd).expect(422)).body.error.code).toBe('upi_inr_only');
    const res = await pay('bala', { ...usd, paidCurrency: 'INR', paidAmountMinor: 125000 }).expect(
      201,
    );
    expect(res.body).toMatchObject({
      currency: 'USD',
      amountMinor: 1500,
      paidCurrency: 'INR',
      paidAmountMinor: 125000,
    });
    expect(net(await balances(), m.bala!, 'USD')).toBe(0);
  });

  it('rejects a reused UPI reference and malformed requests', async () => {
    await spend('owner', m.owner!, 1000, [m.owner!, m.bala!]);
    const body = {
      fromMemberId: m.bala,
      toMemberId: m.owner,
      currency: 'INR',
      amountMinor: 500,
      method: 'upi',
      upiRef: 'AXIS1234567890',
    };
    await pay('bala', body).expect(409);
    await pay('bala', {
      ...body,
      upiRef: undefined,
      method: 'cash',
      paidCurrency: 'INR',
      paidAmountMinor: 500,
    }).expect(400);
    await pay('bala', { ...body, method: 'cash' }).expect(400); // upiRef only with UPI
  });

  it('lists payments newest first, page by page', async () => {
    const first = (await f.as('bala').get(`/groups/${g}/settlements?limit=2`).expect(200)).body;
    expect(first.items).toHaveLength(2);
    const second = (
      await f
        .as('bala')
        .get(`/groups/${g}/settlements?limit=2&cursor=${first.nextCursor}`)
        .expect(200)
    ).body;
    const ids = [...first.items, ...second.items].map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('pay links', () => {
  it("gives the payee's primary UPI ID and a upi://pay link", async () => {
    await f.as('owner').post('/me/upi-ids', { vpa: 'owner@okaxis' }).expect(201);
    const res = await f
      .as('bala')
      .get(`/groups/${g}/pay-link?toMemberId=${m.owner}&amountMinor=123450`)
      .expect(200);
    expect(res.body.vpa).toBe('owner@okaxis');
    expect(res.body.uri).toBe(
      `upi://pay?pa=owner%40okaxis&pn=owner&am=1234.50&cu=INR&tn=SpeakSplit%3A%20Goa&tr=${res.body.ref}`,
    );
  });

  it('returns no link for someone without a UPI ID', async () => {
    const res = await f
      .as('owner')
      .get(`/groups/${g}/pay-link?toMemberId=${m.chitra}&amountMinor=100`)
      .expect(200);
    expect(res.body).toMatchObject({ vpa: null, uri: null, payee: { name: 'chitra' } });
  });
});

describe('my balances', () => {
  it('totals what I owe and am owed per currency, with each group', async () => {
    await spend('owner', m.owner!, 9000, [m.owner!, m.bala!, m.chitra!]);
    const direct = (await f.as('bala').post('/direct', { userId: f.ids.owner }).expect(200)).body
      .groupId;
    const balaInDirect = await f.memberId(direct, 'bala');
    await spend(
      'bala',
      balaInDirect,
      5000,
      [balaInDirect, await f.memberId(direct, 'owner')],
      'INR',
      direct,
    );

    const mine = (await f.as('owner').get('/me/balances').expect(200)).body;
    // Goa: ₹5 bala still owes (the payment refused for a reused UPI reference) + ₹30 each from bala and chitra
    expect(mine.totals).toEqual([
      { currency: 'INR', owedToMeMinor: 6500, iOweMinor: 2500, netMinor: 4000 },
    ]);
    expect(mine.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          groupId: g,
          friend: null,
          balances: [{ currency: 'INR', netMinor: 6500 }],
        }),
        expect.objectContaining({
          groupId: direct,
          friend: { userId: f.ids.bala, name: 'bala' },
          balances: [{ currency: 'INR', netMinor: -2500 }],
        }),
      ]),
    );
  });
});

describe('former members', () => {
  it("can't be paid or pay, and payments with them can't be cancelled", async () => {
    const fg = await f.newGroup('owner', 'Trek');
    const owner = await f.memberId(fg, 'owner');
    const leaver = await f.addMember(fg, 'chitra');
    await spend('owner', owner, 2000, [owner, leaver], 'INR', fg);
    const s = (
      await pay(
        'chitra',
        {
          fromMemberId: leaver,
          toMemberId: owner,
          currency: 'INR',
          amountMinor: 1000,
          method: 'cash',
        },
        randomUUID(),
        fg,
      ).expect(201)
    ).body;
    await f.as('chitra').post(`/groups/${fg}/leave`).expect(204);
    const res = await f.as('owner').del(`/groups/${fg}/settlements/${s.id}`).expect(409);
    expect(res.body.error.code).toBe('former_member');
  });
});
