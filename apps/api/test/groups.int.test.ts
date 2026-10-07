import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './app.js';

let t: TestApp;
let http: ReturnType<TestApp['app']['getHttpServer']>;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestApp();
  http = t.app.getHttpServer();
  for (const name of ['owner', 'member', 'friend', 'stranger', 'blocker']) {
    tokens[name] = await t.token(`auth0|${name}`, { name });
    ids[name] = (await as(name).get('/me').expect(200)).body.id;
  }
});

afterAll(async () => {
  await t?.close();
});

function as(name: string) {
  const auth = () => `Bearer ${tokens[name]}`;
  return {
    get: (path: string) => request(http).get(path).set('Authorization', auth()),
    post: (path: string, body: object = {}) =>
      request(http)
        .post(path)
        .set('Authorization', auth())
        .set('Idempotency-Key', randomUUID())
        .send(body),
    patch: (path: string, body: object) =>
      request(http).patch(path).set('Authorization', auth()).send(body),
    del: (path: string) => request(http).delete(path).set('Authorization', auth()),
  };
}

const sql = (text: string, params: unknown[] = []) => t.db.dataSource.query(text, params);

async function newGroup(name = 'Trip'): Promise<string> {
  return (await as('owner').post('/groups', { name }).expect(201)).body.id;
}

async function addMember(groupId: string, who: string): Promise<string> {
  const [row] = await sql(
    `insert into group_members (group_id, user_id, role) values ($1, $2, 'member') returning id`,
    [groupId, ids[who]],
  );
  return row.id;
}

async function memberId(groupId: string, who: string): Promise<string> {
  const [row] = await sql('select id from group_members where group_id = $1 and user_id = $2', [
    groupId,
    ids[who],
  ]);
  return row.id;
}

/** `payer` paid `amount` for `owes`, all in one currency: owes ends up owing payer `amount`. */
async function expense(
  groupId: string,
  payer: string,
  owes: string,
  amount: number,
  currency = 'INR',
) {
  const runner = t.db.dataSource.createQueryRunner();
  await runner.startTransaction();
  const [e] = await runner.query(
    `insert into expenses (group_id, description, total_minor, currency, split_type, created_by)
     values ($1, 'Dinner', $2, $3, 'exact', $4) returning id`,
    [groupId, amount, currency, ids[payer]],
  );
  await runner.query(
    'insert into expense_payers (expense_id, group_id, member_id, paid_minor) values ($1, $2, $3, $4)',
    [e.id, groupId, await memberId(groupId, payer), amount],
  );
  await runner.query(
    'insert into expense_splits (expense_id, group_id, member_id, owed_minor) values ($1, $2, $3, $4)',
    [e.id, groupId, await memberId(groupId, owes), amount],
  );
  await runner.commitTransaction();
  await runner.release();
}

async function settle(groupId: string, from: string, to: string, amount: number, currency = 'INR') {
  await sql(
    `insert into settlements (group_id, from_member_id, to_member_id, amount_minor, currency, method,
                              status, created_by, confirmed_by, confirmed_at)
     values ($1, $2, $3, $4, $5, 'cash', 'confirmed', $6, $6, now())`,
    [
      groupId,
      await memberId(groupId, from),
      await memberId(groupId, to),
      amount,
      currency,
      ids[from],
    ],
  );
}

describe('archiving', () => {
  it('lets the owner archive: the group becomes read-only and leaves the main list', async () => {
    const id = await newGroup('Goa 2025');
    const res = await as('owner').post(`/groups/${id}/archive`).expect(200);
    expect(res.body.archivedAt).not.toBeNull();
    expect(res.body.version).toBe(2);

    const active = (await as('owner').get('/groups').expect(200)).body.map(
      (g: { id: string }) => g.id,
    );
    const archived = (await as('owner').get('/groups?status=archived').expect(200)).body.map(
      (g: { id: string }) => g.id,
    );
    expect(active).not.toContain(id);
    expect(archived).toContain(id);

    await as('owner').get(`/groups/${id}`).expect(200);
    const write = await as('owner').patch(`/groups/${id}`, { version: 2, name: 'x' }).expect(409);
    expect(write.body.error.code).toBe('archived');
  });

  it('restores an archived group', async () => {
    const id = await newGroup();
    await as('owner').post(`/groups/${id}/archive`).expect(200);
    const res = await as('owner').post(`/groups/${id}/unarchive`).expect(200);
    expect(res.body.archivedAt).toBeNull();
    await as('owner')
      .patch(`/groups/${id}`, { version: res.body.version, name: 'Back' })
      .expect(200);
  });

  it('is owner-only for shared groups, and not for former members or outsiders', async () => {
    const id = await newGroup();
    await addMember(id, 'member');
    const res = await as('member').post(`/groups/${id}/archive`).expect(403);
    expect(res.body.error.message).toMatch(/owner/);
    await as('stranger').post(`/groups/${id}/archive`).expect(404);
  });

  it('rejects unknown status filters', async () => {
    await as('owner').get('/groups?status=deleted').expect(400);
  });
});

describe('deleting', () => {
  it('refuses while anyone has a non-zero balance, listing the currencies', async () => {
    const id = await newGroup();
    await addMember(id, 'member');
    await expense(id, 'owner', 'member', 50000);
    await expense(id, 'member', 'owner', 1000, 'USD');
    const res = await as('owner').del(`/groups/${id}`).expect(409);
    expect(res.body.error.code).toBe('unsettled');
    expect(res.body.error.details).toEqual([
      { currency: 'INR', members: 2 },
      { currency: 'USD', members: 2 },
    ]);
    await as('owner').get(`/groups/${id}`).expect(200);
  });

  it('deletes once everyone is settled, keeping the audit record', async () => {
    const id = await newGroup();
    await addMember(id, 'member');
    await expense(id, 'owner', 'member', 50000);
    await settle(id, 'member', 'owner', 50000);
    await as('owner').del(`/groups/${id}`).expect(204);
    await as('owner').get(`/groups/${id}`).expect(404);
    const [{ n }] = await sql('select count(*)::int as n from expenses where group_id = $1', [id]);
    expect(n).toBe(0);
    const audit = await sql(`select action from audit_log where entity_id = $1 order by id`, [id]);
    expect(audit.map((a: { action: string }) => a.action)).toEqual(['create', 'delete']);
  });

  it('deletes an archived group too', async () => {
    const id = await newGroup();
    await as('owner').post(`/groups/${id}/archive`).expect(200);
    await as('owner').del(`/groups/${id}`).expect(204);
  });

  it('is owner-only', async () => {
    const id = await newGroup();
    await addMember(id, 'member');
    await as('member').del(`/groups/${id}`).expect(403);
    await as('stranger').del(`/groups/${id}`).expect(404);
  });
});

describe('friend-to-friend groups', () => {
  beforeAll(async () => {
    // owner and friend know each other through a shared group
    const shared = await newGroup('Shared');
    await addMember(shared, 'friend');
    await addMember(shared, 'blocker');
    await sql('insert into blocks (blocker_id, blocked_id) values ($1, $2)', [
      ids.blocker,
      ids.owner,
    ]);
  });

  it('creates one group per pair, whoever opens it and however often', async () => {
    const first = await as('owner').post('/direct', { userId: ids.friend }).expect(200);
    expect(first.body).toMatchObject({
      friend: { userId: ids.friend, name: 'friend' },
      archivedAt: null,
    });
    const again = await as('owner').post('/direct', { userId: ids.friend }).expect(200);
    const reverse = await as('friend').post('/direct', { userId: ids.owner }).expect(200);
    expect(again.body.groupId).toBe(first.body.groupId);
    expect(reverse.body.groupId).toBe(first.body.groupId);
    expect(reverse.body.friend.userId).toBe(ids.owner);
  });

  it('creates exactly one group when both open it at the same moment', async () => {
    const [{ id: sharedId }] = await sql(`select id from groups where name = 'Shared'`);
    const racer = await t.token('auth0|racer', { name: 'racer' });
    tokens.racer = racer;
    ids.racer = (await as('racer').get('/me')).body.id;
    await addMember(sharedId, 'racer');
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        i % 2
          ? as('racer').post('/direct', { userId: ids.friend })
          : as('friend').post('/direct', { userId: ids.racer }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(results.map(() => 200));
    expect(new Set(results.map((r) => r.body.groupId)).size).toBe(1);
    const [{ n }] = await sql('select count(*)::int as n from group_members where group_id = $1', [
      results[0]!.body.groupId,
    ]);
    expect(n).toBe(2);
  });

  it('keeps direct groups out of the main list but readable as a group', async () => {
    const direct = (await as('owner').post('/direct', { userId: ids.friend })).body.groupId;
    const groups = (await as('owner').get('/groups')).body.map((g: { id: string }) => g.id);
    expect(groups).not.toContain(direct);
    const list = (await as('owner').get('/direct').expect(200)).body;
    expect(list.map((d: { groupId: string }) => d.groupId)).toContain(direct);
    const detail = await as('friend').get(`/groups/${direct}`).expect(200);
    expect(detail.body.members).toHaveLength(2);
  });

  it('lets either person archive it (no owner-only rule for a pair)', async () => {
    const direct = (await as('owner').post('/direct', { userId: ids.friend })).body.groupId;
    await as('friend').post(`/groups/${direct}/archive`).expect(200);
    await as('owner').post(`/groups/${direct}/unarchive`).expect(200);
  });

  it('refuses strangers, yourself, unknown users and anyone in a block', async () => {
    await as('owner').post('/direct', { userId: ids.stranger }).expect(404);
    await as('owner').post('/direct', { userId: randomUUID() }).expect(404);
    const self = await as('owner').post('/direct', { userId: ids.owner }).expect(400);
    expect(self.body.error.code).toBe('self');
    const blockedByThem = await as('owner').post('/direct', { userId: ids.blocker }).expect(403);
    expect(blockedByThem.body.error.code).toBe('blocked');
    await as('blocker').post('/direct', { userId: ids.owner }).expect(403);
  });
});
