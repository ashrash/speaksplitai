import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './app.js';
import { fixtures } from './fixtures.js';

let t: TestApp;
let f: ReturnType<typeof fixtures>;

beforeAll(async () => {
  t = await createTestApp();
  f = fixtures(t);
  for (const name of ['owner', 'asha', 'bala', 'chitra', 'blocked', 'outsider']) await f.user(name);
  await f.sql('insert into blocks (blocker_id, blocked_id) values ($1, $2)', [
    f.ids.owner,
    f.ids.blocked,
  ]);
});

afterAll(async () => {
  await t?.close();
});

async function invite(groupId: string, body: object = {}, as = 'owner') {
  return (await f.as(as).post(`/groups/${groupId}/invites`, body).expect(201)).body;
}

describe('invite links', () => {
  it('creates a link whose token is returned once and stored only as a hash', async () => {
    const g = await f.newGroup('owner', 'Goa');
    const inv = await invite(g, { maxUses: 5, expiresInHours: 24 });
    expect(inv.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inv).toMatchObject({
      maxUses: 5,
      useCount: 0,
      placeholder: null,
      createdBy: { name: 'owner' },
    });
    const [row] = await f.sql('select encode(token_hash, $2) as h from invites where id = $1', [
      inv.id,
      'escape',
    ]);
    expect(row.h).not.toContain(inv.token);
    const list = (await f.as('owner').get(`/groups/${g}/invites`).expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0].token).toBeUndefined();
  });

  it('shows a preview, then joins on accept; accepting again changes nothing', async () => {
    const g = await f.newGroup('owner', 'Flat');
    const { token } = await invite(g);
    const preview = await f.as('asha').get(`/invites/${token}`).expect(200);
    expect(preview.body).toMatchObject({
      group: { id: g, name: 'Flat', memberCount: 1 },
      invitedBy: 'owner',
      placeholderName: null,
      alreadyMember: false,
    });
    const joined = await f.as('asha').post(`/invites/${token}/accept`).expect(200);
    expect(joined.body).toMatchObject({ groupId: g, outcome: 'joined' });
    const again = await f.as('asha').post(`/invites/${token}/accept`).expect(200);
    expect(again.body.outcome).toBe('already');
    expect((await f.as('asha').get(`/groups/${g}`).expect(200)).body.me.role).toBe('member');
    const [{ use_count }] = await f.sql('select use_count from invites where group_id = $1', [g]);
    expect(use_count).toBe(1);
  });

  it('enforces max uses even when people accept at the same moment', async () => {
    const g = await f.newGroup('owner');
    const { token } = await invite(g, { maxUses: 2 });
    const names = ['asha', 'bala', 'chitra'];
    const results = await Promise.all(names.map((n) => f.as(n).post(`/invites/${token}/accept`)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 410]);
    expect(results.find((r) => r.status === 410)!.body.error.code).toBe('invite_used_up');
    const [{ n }] = await f.sql(
      'select count(*)::int as n from group_members where group_id = $1',
      [g],
    );
    expect(n).toBe(3); // owner + 2
  });

  it('rejects expired, revoked and unknown links with clear codes', async () => {
    const g = await f.newGroup('owner');
    const expired = await invite(g);
    await f.sql(
      `update invites set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where id = $1`,
      [expired.id],
    );
    expect(
      (await f.as('asha').post(`/invites/${expired.token}/accept`).expect(410)).body.error.code,
    ).toBe('invite_expired');

    const revoked = await invite(g);
    await f.as('owner').del(`/groups/${g}/invites/${revoked.id}`).expect(204);
    expect((await f.as('asha').get(`/invites/${revoked.token}`).expect(410)).body.error.code).toBe(
      'invite_revoked',
    );

    expect(
      (
        await f
          .as('asha')
          .get(`/invites/${'x'.repeat(43)}`)
          .expect(404)
      ).body.error.code,
    ).toBe('invite_not_found');
    await f.as('asha').get('/invites/too-short').expect(400);
  });

  it('refuses anyone in a block with the person who made the invite', async () => {
    const g = await f.newGroup('owner');
    const { token } = await invite(g);
    expect(
      (await f.as('blocked').post(`/invites/${token}/accept`).expect(403)).body.error.code,
    ).toBe('blocked');
  });

  it('refuses joining an archived group', async () => {
    const g = await f.newGroup('owner');
    const { token } = await invite(g);
    await f.as('owner').post(`/groups/${g}/archive`).expect(200);
    expect((await f.as('asha').post(`/invites/${token}/accept`).expect(409)).body.error.code).toBe(
      'archived',
    );
  });

  it('lets only current members manage invites', async () => {
    const g = await f.newGroup('owner');
    await f.as('outsider').post(`/groups/${g}/invites`, {}).expect(404);
    await f.as('outsider').get(`/groups/${g}/invites`).expect(404);
  });
});

describe('placeholder members', () => {
  it('adds someone by name, then lets the invited person take over their history', async () => {
    const g = await f.newGroup('owner', 'Trek');
    const dev = (await f.as('owner').post(`/groups/${g}/members`, { name: 'Dev' }).expect(201))
      .body;
    expect(dev).toMatchObject({ userId: null, name: 'Dev' });
    // Dev already owes the owner ₹500 before signing up
    await f.expenseBetween(g, await f.memberId(g, 'owner'), dev.id, 50000);

    const inv = await invite(g, { placeholderMemberId: dev.id, maxUses: 10 });
    expect(inv).toMatchObject({ maxUses: 1, placeholder: { memberId: dev.id, name: 'Dev' } });
    expect((await f.as('bala').get(`/invites/${inv.token}`)).body.placeholderName).toBe('Dev');

    const claimed = await f.as('bala').post(`/invites/${inv.token}/accept`).expect(200);
    expect(claimed.body).toEqual({
      kind: 'group',
      groupId: g,
      memberId: dev.id,
      friendUserId: null,
      outcome: 'claimed',
    });
    const [row] = await f.sql('select user_id, claimed_at from group_members where id = $1', [
      dev.id,
    ]);
    expect(row.user_id).toBe(f.ids.bala);
    expect(row.claimed_at).not.toBeNull();
    const [bal] = await f.sql('select net_minor from member_balances where member_id = $1', [
      dev.id,
    ]);
    expect(Number(bal.net_minor)).toBe(-50000);
  });

  it("won't let an existing member take over a placeholder too", async () => {
    const g = await f.newGroup('owner');
    await f.addMember(g, 'asha');
    const p = (await f.as('owner').post(`/groups/${g}/members`, { name: 'Someone' }).expect(201))
      .body;
    const inv = await invite(g, { placeholderMemberId: p.id });
    expect((await f.as('asha').post(`/invites/${inv.token}/accept`)).body.outcome).toBe('already');
    await f
      .as('owner')
      .del(`/groups/${g}/members/${await f.memberId(g, 'asha')}`)
      .expect(204);
    expect(
      (await f.as('asha').post(`/invites/${inv.token}/accept`).expect(409)).body.error.code,
    ).toBe('already_member');
  });

  it('rejects duplicate placeholder names in a group', async () => {
    const g = await f.newGroup('owner');
    await f.as('owner').post(`/groups/${g}/members`, { name: 'Dev' }).expect(201);
    await f.as('owner').post(`/groups/${g}/members`, { name: 'dev' }).expect(409);
  });
});

describe('removing and leaving', () => {
  it('blocks removing someone who owes or is owed money, then allows it once settled', async () => {
    const g = await f.newGroup('owner');
    const ashaMember = await f.addMember(g, 'asha');
    await f.expense(g, 'owner', 'asha', 30000);
    const res = await f.as('owner').del(`/groups/${g}/members/${ashaMember}`).expect(409);
    expect(res.body.error).toMatchObject({
      code: 'unsettled',
      details: [{ currency: 'INR', netMinor: -30000 }],
    });
    await f.settle(g, 'asha', 'owner', 30000);
    await f.as('owner').del(`/groups/${g}/members/${ashaMember}`).expect(204);
    // removed members keep read-only access
    const view = await f.as('asha').get(`/groups/${g}`).expect(200);
    expect(view.body.me.leftAt).not.toBeNull();
    await f.as('asha').patch(`/groups/${g}`, { version: 1, name: 'x' }).expect(403);
  });

  it('lets a former member rejoin through a new invite', async () => {
    const g = await f.newGroup('owner');
    const m = await f.addMember(g, 'bala');
    await f.as('owner').del(`/groups/${g}/members/${m}`).expect(204);
    const { token } = await invite(g);
    const res = await f.as('bala').post(`/invites/${token}/accept`).expect(200);
    expect(res.body).toEqual({
      kind: 'group',
      groupId: g,
      memberId: m,
      friendUserId: null,
      outcome: 'rejoined',
    });
    expect((await f.as('bala').get(`/groups/${g}`)).body.me.leftAt).toBeNull();
  });

  it('only the owner removes others; the owner cannot be removed', async () => {
    const g = await f.newGroup('owner');
    await f.addMember(g, 'asha');
    const chitra = await f.addMember(g, 'chitra');
    await f.as('asha').del(`/groups/${g}/members/${chitra}`).expect(403);
    const ownerMember = await f.memberId(g, 'owner');
    expect(
      (await f.as('owner').del(`/groups/${g}/members/${ownerMember}`).expect(409)).body.error.code,
    ).toBe('owner');
  });

  it('lets a member leave when settled, and not before; owners cannot leave', async () => {
    const g = await f.newGroup('owner');
    await f.addMember(g, 'chitra');
    await f.expense(g, 'chitra', 'owner', 1000, 'USD');
    expect((await f.as('chitra').post(`/groups/${g}/leave`).expect(409)).body.error.code).toBe(
      'unsettled',
    );
    await f.settle(g, 'owner', 'chitra', 1000, 'USD');
    await f.as('chitra').post(`/groups/${g}/leave`).expect(204);
    await f.as('chitra').post(`/groups/${g}/leave`).expect(403); // already left
    expect((await f.as('owner').post(`/groups/${g}/leave`).expect(409)).body.error.code).toBe(
      'owner',
    );
  });

  it('records joins, claims, removals and leaves in the audit log', async () => {
    const actions = await f.sql(
      `select distinct action from audit_log where entity = 'member' order by action`,
    );
    expect(actions.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['claim', 'create', 'join', 'leave', 'remove']),
    );
  });
});
