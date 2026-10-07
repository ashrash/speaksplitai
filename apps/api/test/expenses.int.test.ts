import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './app.js';
import { fixtures } from './fixtures.js';

let t: TestApp;
let f: ReturnType<typeof fixtures>;
let g: string; // group: owner, bala, chitra (joined in that order)
const m: Record<string, string> = {}; // member ids in g

beforeAll(async () => {
  t = await createTestApp();
  f = fixtures(t);
  for (const name of ['owner', 'bala', 'chitra', 'outsider', 'leaver']) await f.user(name);
  g = await f.newGroup('owner', 'Goa');
  m.owner = await f.memberId(g, 'owner');
  m.bala = await f.addMember(g, 'bala');
  m.chitra = await f.addMember(g, 'chitra');
});

afterAll(async () => {
  await t?.close();
});

const equal = (total: number, memberIds: string[], extra: object = {}) => ({
  description: 'Dinner',
  totalMinor: total,
  expenseDate: '2026-10-01',
  payers: [{ memberId: m.owner, paidMinor: total }],
  split: { type: 'equal', memberIds },
  ...extra,
});

function create(body: object, as = 'owner', groupId = g) {
  return f.as(as).post(`/groups/${groupId}/expenses`, body);
}

const owedBy = (detail: { splits: Array<{ memberId: string; owedMinor: number }> }) =>
  Object.fromEntries(detail.splits.map((s) => [s.memberId, s.owedMinor]));

describe('creating', () => {
  it('splits ₹100 three ways, giving the extra paisa to whoever joined first, whatever the order sent', async () => {
    const res = await create(equal(10000, [m.chitra!, m.bala!, m.owner!])).expect(201);
    expect(res.body).toMatchObject({
      totalMinor: 10000,
      currency: 'INR',
      splitType: 'equal',
      version: 1,
    });
    expect(owedBy(res.body)).toEqual({ [m.owner!]: 3334, [m.bala!]: 3333, [m.chitra!]: 3333 });
    expect(res.body.splits.map((s: { name: string }) => s.name)).toEqual([
      'owner',
      'bala',
      'chitra',
    ]);
  });

  it('keeps percent and share inputs as entered', async () => {
    const pct = await create({
      ...equal(10000, []),
      split: {
        type: 'percent',
        percents: [
          { memberId: m.owner, percent: '33.33' },
          { memberId: m.bala, percent: '33.33' },
          { memberId: m.chitra, percent: '33.34' },
        ],
      },
    }).expect(201);
    expect(
      pct.body.splits.map((s: { owedMinor: number; shareValue: string }) => [
        s.owedMinor,
        s.shareValue,
      ]),
    ).toEqual([
      [3333, '33.33'],
      [3333, '33.33'],
      [3334, '33.34'],
    ]);
    const shares = await create({
      ...equal(9000, []),
      split: {
        type: 'shares',
        shares: [
          { memberId: m.owner, shares: '2' },
          { memberId: m.bala, shares: '1' },
        ],
      },
    }).expect(201);
    expect(owedBy(shares.body)).toEqual({ [m.owner!]: 6000, [m.bala!]: 3000 });
  });

  it('supports several payers, a payer outside the split, other currencies and placeholders', async () => {
    const dev = (await f.as('owner').post(`/groups/${g}/members`, { name: 'Dev' }).expect(201)).body
      .id;
    const res = await create({
      description: 'Taxi',
      totalMinor: 3000,
      currency: 'USD',
      expenseDate: '2026-10-02',
      payers: [
        { memberId: m.owner, paidMinor: 1000 },
        { memberId: m.chitra, paidMinor: 2000 },
      ],
      split: {
        type: 'exact',
        amounts: [
          { memberId: m.bala, amountMinor: 1500 },
          { memberId: dev, amountMinor: 1500 },
        ],
      },
    }).expect(201);
    expect(res.body.currency).toBe('USD');
    expect(res.body.payers).toHaveLength(2);
    expect(res.body.splits.find((s: { memberId: string }) => s.memberId === dev).name).toBe('Dev');
  });

  it.each([
    [
      'payers that miss the total',
      { payers: [{ memberId: 'OWNER', paidMinor: 999 }] },
      'payers_total',
    ],
    [
      'the same payer twice',
      {
        payers: [
          { memberId: 'OWNER', paidMinor: 500 },
          { memberId: 'OWNER', paidMinor: 500 },
        ],
      },
      'duplicate_payer',
    ],
    [
      'exact amounts that miss the total',
      { split: { type: 'exact', amounts: [{ memberId: 'OWNER', amountMinor: 999 }] } },
      'invalid_split',
    ],
    [
      'percentages that miss 100',
      { split: { type: 'percent', percents: [{ memberId: 'OWNER', percent: '99.99' }] } },
      'invalid_split',
    ],
  ])('rejects %s (422)', async (_label, override, code) => {
    const body = JSON.parse(
      JSON.stringify({ ...equal(1000, [m.owner!]), ...override }).replaceAll('OWNER', m.owner!),
    );
    expect((await create(body).expect(422)).body.error.code).toBe(code);
  });

  it('rejects members of another group and malformed input', async () => {
    const other = await f.newGroup('outsider');
    const stranger = await f.memberId(other, 'outsider');
    expect((await create(equal(1000, [stranger])).expect(422)).body.error.code).toBe(
      'unknown_member',
    );
    await create({ ...equal(1000, [m.owner!]), totalMinor: 10.5 }).expect(400);
    await create({ ...equal(1000, [m.owner!]), expenseDate: '1/10/2026' }).expect(400);
    await create({ ...equal(1000, [m.owner!]), split: { type: 'itemized' } }).expect(400);
  });

  it('is safe to retry with the same Idempotency-Key', async () => {
    const key = randomUUID();
    const send = () =>
      request(t.app.getHttpServer())
        .post(`/groups/${g}/expenses`)
        .set('Authorization', `Bearer ${f.tokens.owner}`)
        .set('Idempotency-Key', key)
        .send(equal(777, [m.owner!, m.bala!], { description: 'Retry me' }));
    const first = await send().expect(201);
    const second = await send().expect(201);
    expect(second.body.id).toBe(first.body.id);
    const [{ n }] = await f.sql(
      `select count(*)::int as n from expenses where description = 'Retry me'`,
    );
    expect(n).toBe(1);
  });

  it('keeps outsiders out and former members read-only', async () => {
    await create(equal(1000, [m.owner!]), 'outsider').expect(404);
  });
});

describe('listing', () => {
  let lg: string;
  const lm: Record<string, string> = {};

  beforeAll(async () => {
    lg = await f.newGroup('owner', 'Flat');
    lm.owner = await f.memberId(lg, 'owner');
    lm.bala = await f.addMember(lg, 'bala');
    lm.chitra = await f.addMember(lg, 'chitra');
    // 7 expenses over 4 days; bala is in the odd-numbered ones
    for (let i = 1; i <= 7; i++) {
      const members = i % 2 ? [lm.owner!, lm.bala!] : [lm.owner!, lm.chitra!];
      await create(
        {
          description: `E${i}`,
          totalMinor: 1000 * i,
          expenseDate: `2026-09-0${Math.ceil(i / 2)}`,
          payers: [{ memberId: lm.owner, paidMinor: 1000 * i }],
          split: { type: 'equal', memberIds: members },
        },
        'owner',
        lg,
      ).expect(201);
    }
  });

  it("shows only expenses you're part of by default, all on request", async () => {
    const mine = (await f.as('bala').get(`/groups/${lg}/expenses`).expect(200)).body;
    expect(mine.items.map((e: { description: string }) => e.description)).toEqual([
      'E7',
      'E5',
      'E3',
      'E1',
    ]);
    expect(mine.items[0].mine).toEqual({ paidMinor: 0, owedMinor: 3500, netMinor: -3500 });
    const all = (await f.as('bala').get(`/groups/${lg}/expenses?scope=all`).expect(200)).body;
    expect(all.items).toHaveLength(7);
  });

  it('pages newest first without gaps or repeats', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: Response = await f
        .as('owner')
        .get(`/groups/${lg}/expenses?limit=3${cursor ? `&cursor=${cursor}` : ''}`)
        .expect(200);
      seen.push(...res.body.items.map((e: { description: string }) => e.description));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['E7', 'E6', 'E5', 'E4', 'E3', 'E2', 'E1']);
  });

  it('rejects a tampered cursor', async () => {
    expect(
      (await f.as('owner').get(`/groups/${lg}/expenses?cursor=abc`).expect(400)).body.error.code,
    ).toBe('invalid_cursor');
  });
});

describe('editing, deleting and restoring', () => {
  it('replaces the split, bumps the version, and rejects a stale version', async () => {
    const created = (await create(equal(6000, [m.owner!, m.bala!]))).body;
    const res = await f
      .as('bala')
      .patch(`/groups/${g}/expenses/${created.id}`, {
        ...equal(9000, [m.owner!, m.bala!, m.chitra!]),
        description: 'Dinner (fixed)',
        version: 1,
      })
      .expect(200);
    expect(res.body).toMatchObject({ description: 'Dinner (fixed)', totalMinor: 9000, version: 2 });
    expect(owedBy(res.body)).toEqual({ [m.owner!]: 3000, [m.bala!]: 3000, [m.chitra!]: 3000 });
    const stale = await f
      .as('chitra')
      .patch(`/groups/${g}/expenses/${created.id}`, { ...equal(100, [m.owner!]), version: 1 })
      .expect(409);
    expect(stale.body.error.code).toBe('stale_version');
  });

  it('soft-deletes (gone from lists and balances, detail still readable) and restores', async () => {
    const created = (await create(equal(5000, [m.bala!], { description: 'Undo me' }))).body;
    const balance = async () =>
      Number(
        (
          await f.sql(
            'select net_minor from member_balances where member_id = $1 and currency = $2',
            [m.bala, 'INR'],
          )
        )[0].net_minor,
      );
    const before = await balance();
    await f.as('owner').del(`/groups/${g}/expenses/${created.id}`).expect(204);
    await f.as('owner').del(`/groups/${g}/expenses/${created.id}`).expect(204); // repeat-safe
    expect(await balance()).toBe(before + 5000);
    const list = (await f.as('owner').get(`/groups/${g}/expenses?scope=all&limit=100`)).body.items;
    expect(list.map((e: { id: string }) => e.id)).not.toContain(created.id);
    expect(
      (await f.as('owner').get(`/groups/${g}/expenses/${created.id}`).expect(200)).body.deletedAt,
    ).not.toBeNull();
    const edit = await f
      .as('owner')
      .patch(`/groups/${g}/expenses/${created.id}`, { ...equal(5000, [m.bala!]), version: 2 })
      .expect(409);
    expect(edit.body.error.code).toBe('deleted');

    const restored = await f
      .as('owner')
      .post(`/groups/${g}/expenses/${created.id}/restore`)
      .expect(200);
    expect(restored.body).toMatchObject({ deletedAt: null, version: 3 });
    expect(await balance()).toBe(before);
  });

  it('records create, update, delete and restore in the audit log', async () => {
    const actions = await f.sql(
      `select distinct action from audit_log where entity = 'expense' order by action`,
    );
    expect(actions.map((a: { action: string }) => a.action)).toEqual([
      'create',
      'delete',
      'restore',
      'update',
    ]);
  });
});

describe('former members', () => {
  let fg: string;
  let owner: string;
  let leaver: string;
  let shared: string;

  beforeAll(async () => {
    fg = await f.newGroup('owner', 'Trek');
    owner = await f.memberId(fg, 'owner');
    leaver = await f.addMember(fg, 'leaver');
    shared = (
      await create(
        {
          description: 'Tent',
          totalMinor: 4000,
          expenseDate: '2026-09-10',
          payers: [{ memberId: owner, paidMinor: 4000 }],
          split: { type: 'equal', memberIds: [owner, leaver] },
        },
        'owner',
        fg,
      ).expect(201)
    ).body.id;
    await f.settle(fg, 'leaver', 'owner', 2000);
    await f.as('leaver').post(`/groups/${fg}/leave`).expect(204);
  });

  const tent = (total: number, version: number, description = 'Tent') => ({
    description,
    totalMinor: total,
    expenseDate: '2026-09-10',
    payers: [{ memberId: owner, paidMinor: total }],
    split: { type: 'equal', memberIds: [owner, leaver] },
    version,
  });

  it("can't change what a former member owes, but can fix the description", async () => {
    const res = await f
      .as('owner')
      .patch(`/groups/${fg}/expenses/${shared}`, tent(5000, 1))
      .expect(409);
    expect(res.body.error.code).toBe('former_member');
    await f
      .as('owner')
      .patch(`/groups/${fg}/expenses/${shared}`, tent(4000, 1, 'Tent hire'))
      .expect(200);
  });

  it("can't delete such an expense, or add the former member to a new one", async () => {
    expect(
      (await f.as('owner').del(`/groups/${fg}/expenses/${shared}`).expect(409)).body.error.code,
    ).toBe('former_member');
    const res = await create({ ...tent(1000, 1), version: undefined }, 'owner', fg).expect(422);
    expect(res.body.error.code).toBe('former_member');
  });

  it('lets the former member read but not write', async () => {
    await f.as('leaver').get(`/groups/${fg}/expenses`).expect(200);
    await f.as('leaver').get(`/groups/${fg}/expenses/${shared}`).expect(200);
    await create(equal(100, [owner]), 'leaver', fg).expect(403);
  });
});

describe('friend-to-friend groups', () => {
  it('take expenses like any group', async () => {
    const direct = (await f.as('owner').post('/direct', { userId: f.ids.bala }).expect(200)).body
      .groupId;
    const me = await f.memberId(direct, 'owner');
    const them = await f.memberId(direct, 'bala');
    const res = await create(
      {
        description: 'Coffee',
        totalMinor: 30000,
        expenseDate: '2026-10-03',
        payers: [{ memberId: me, paidMinor: 30000 }],
        split: { type: 'equal', memberIds: [me, them] },
      },
      'owner',
      direct,
    ).expect(201);
    expect(owedBy(res.body)).toEqual({ [me]: 15000, [them]: 15000 });
    const list = (await f.as('bala').get(`/groups/${direct}/expenses`).expect(200)).body.items;
    expect(list[0].mine).toEqual({ paidMinor: 0, owedMinor: 15000, netMinor: -15000 });
  });
});
