import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './app.js';
import { fixtures } from './fixtures.js';

const NS = 'https://speaksplit.test/';
let t: TestApp;
let f: ReturnType<typeof fixtures>;

/** Signs in a user whose token carries a verified email (via the namespaced claims). */
async function verifiedUser(name: string, email: string) {
  f.tokens[name] = await t.token(`auth0|${name}`, {
    name,
    [`${NS}email`]: email,
    [`${NS}email_verified`]: true,
  });
  f.ids[name] = (await f.as(name).get('/me').expect(200)).body.id;
}

beforeAll(async () => {
  process.env.AUTH0_CLAIM_NAMESPACE = NS;
  t = await createTestApp();
  f = fixtures(t);
  await verifiedUser('asha', 'asha@example.com');
  await verifiedUser('bala', 'Bala@Example.com');
  for (const name of ['chitra', 'dev', 'eve', 'mallory', 'spammer']) await f.user(name);
  await f.sql(`update users set email = 'eve@example.com' where id = $1`, [f.ids.eve]);
  await f.sql('insert into blocks (blocker_id, blocked_id) values ($1, $2)', [
    f.ids.eve,
    f.ids.asha,
  ]);
});

afterAll(async () => {
  delete process.env.AUTH0_CLAIM_NAMESPACE;
  await t?.close();
});

const friendIds = async (who: string) =>
  (
    (await f.as(who).get('/friends').expect(200)).body as Array<{
      userId: string;
      isFriend: boolean;
    }>
  )
    .filter((x) => x.isFriend)
    .map((x) => x.userId);

describe('verified email from the sign-in token', () => {
  it('stores it, lower-cased, only when Auth0 marks it verified', async () => {
    expect((await f.as('bala').get('/me')).body.email).toBe('bala@example.com');
    const token = await t.token('auth0|unverified', {
      name: 'U',
      email: 'u@example.com',
      email_verified: false,
    });
    expect((await f.as('asha').get('/me')).body.email).toBe('asha@example.com');
    f.tokens.unverified = token;
    expect((await f.as('unverified').get('/me').expect(200)).body.email).toBeNull();
  });

  it("doesn't take an address another active account already has", async () => {
    f.tokens.twin = await t.token('google-oauth2|asha-twin', {
      name: 'Asha (Google)',
      email: 'asha@example.com',
      email_verified: true,
    });
    expect((await f.as('twin').get('/me').expect(200)).body.email).toBeNull();
  });
});

describe('friend invite links', () => {
  it('makes whoever opens the link a friend of its creator', async () => {
    const inv = (await f.as('asha').post('/friends/invites', { maxUses: 2 }).expect(201)).body;
    expect(inv.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const preview = await f.as('chitra').get(`/invites/${inv.token}`).expect(200);
    expect(preview.body).toMatchObject({
      kind: 'friend',
      group: null,
      invitedBy: 'asha',
      alreadyMember: false,
    });

    const res = await f.as('chitra').post(`/invites/${inv.token}/accept`).expect(200);
    expect(res.body).toEqual({
      kind: 'friend',
      groupId: null,
      memberId: null,
      friendUserId: f.ids.asha,
      outcome: 'befriended',
    });
    expect(
      (await f.as('chitra').post(`/invites/${inv.token}/accept`).expect(200)).body.outcome,
    ).toBe('already');
    expect(await friendIds('asha')).toContain(f.ids.chitra);
    expect(await friendIds('chitra')).toContain(f.ids.asha);
  });

  it('refuses your own link, blocked people, and revoked links', async () => {
    const inv = (await f.as('asha').post('/friends/invites', {}).expect(201)).body;
    expect(
      (await f.as('asha').post(`/invites/${inv.token}/accept`).expect(400)).body.error.code,
    ).toBe('self');
    expect(
      (await f.as('eve').post(`/invites/${inv.token}/accept`).expect(403)).body.error.code,
    ).toBe('blocked');
    const list = (await f.as('asha').get('/friends/invites').expect(200)).body;
    expect(list.map((i: { id: string }) => i.id)).toContain(inv.id);
    await f.as('asha').del(`/friends/invites/${inv.id}`).expect(204);
    await f.as('mallory').post(`/invites/${inv.token}/accept`).expect(410);
    await f.as('bala').del(`/friends/invites/${inv.id}`).expect(404);
  });
});

describe('friend requests', () => {
  it('to a user: sent, shown to both sides, accepted', async () => {
    expect(
      (await f.as('dev').post('/friends/requests', { userId: f.ids.bala }).expect(202)).body,
    ).toEqual({ status: 'sent' });
    const outgoing = (await f.as('dev').get('/friends/requests')).body.outgoing;
    expect(outgoing).toEqual([
      expect.objectContaining({ person: { userId: f.ids.bala, name: 'bala' } }),
    ]);
    const incoming = (await f.as('bala').get('/friends/requests')).body.incoming;
    expect(incoming).toEqual([
      expect.objectContaining({ person: { userId: f.ids.dev, name: 'dev' } }),
    ]);
    await f.as('bala').post(`/friends/requests/${incoming[0].id}/accept`).expect(200);
    expect(await friendIds('bala')).toContain(f.ids.dev);
    expect(
      (await f.as('dev').post('/friends/requests', { userId: f.ids.bala }).expect(200)).body.status,
    ).toBe('already_friends');
  });

  it('connects at once when the other person had already asked', async () => {
    await f.as('mallory').post('/friends/requests', { userId: f.ids.chitra }).expect(202);
    expect(
      (await f.as('chitra').post('/friends/requests', { userId: f.ids.mallory }).expect(200)).body
        .status,
    ).toBe('accepted');
    expect(await friendIds('mallory')).toContain(f.ids.chitra);
    expect((await f.as('mallory').get('/friends/requests')).body.outgoing).toEqual([]);
  });

  it('declines quietly and lets the sender cancel', async () => {
    await f.as('mallory').post('/friends/requests', { userId: f.ids.dev }).expect(202);
    const req = (await f.as('dev').get('/friends/requests')).body.incoming[0];
    await f.as('dev').post(`/friends/requests/${req.id}/decline`).expect(204);
    expect((await f.as('mallory').get('/friends/requests')).body.outgoing).toEqual([]);
    expect(await friendIds('dev')).not.toContain(f.ids.mallory);

    await f.as('mallory').post('/friends/requests', { userId: f.ids.asha }).expect(202);
    const mine = (await f.as('mallory').get('/friends/requests')).body.outgoing[0];
    await f.as('asha').del(`/friends/requests/${mine.id}`).expect(404); // not theirs to cancel
    await f.as('mallory').del(`/friends/requests/${mine.id}`).expect(204);
    expect((await f.as('asha').get('/friends/requests')).body.incoming).toEqual([]);
  });

  it('by email: delivered to the verified owner, case-insensitively', async () => {
    await f.as('chitra').post('/friends/requests', { email: 'BALA@example.com' }).expect(202);
    const out = (await f.as('chitra').get('/friends/requests')).body.outgoing[0];
    expect(out.person).toEqual({ userId: null, name: 'b•••@example.com' }); // not revealed before acceptance
    const incoming = (await f.as('bala').get('/friends/requests')).body.incoming;
    const fromChitra = incoming.find(
      (r: { person: { userId: string } }) => r.person.userId === f.ids.chitra,
    );
    await f.as('bala').post(`/friends/requests/${fromChitra.id}/accept`).expect(200);
    expect(await friendIds('chitra')).toContain(f.ids.bala);
  });

  it('answers identically whether or not an email or phone is registered', async () => {
    const known = await f.as('dev').post('/friends/requests', { email: 'asha@example.com' });
    const unknown = await f
      .as('dev')
      .post('/friends/requests', { email: 'nobody-here@example.com' });
    const blocked = await f.as('asha').post('/friends/requests', { email: 'eve@example.com' });
    const phone = await f.as('dev').post('/friends/requests', { phone: '+919876543210' });
    for (const r of [known, unknown, blocked, phone]) {
      expect(r.status).toBe(202);
      expect(r.body).toEqual({ status: 'sent' });
    }
    // the blocked request is never delivered
    expect((await f.as('eve').get('/friends/requests')).body.incoming).toEqual([]);
    const phoneOut = (await f.as('dev').get('/friends/requests')).body.outgoing.find(
      (r: { person: { name: string } }) => r.person.name.startsWith('+91'),
    );
    expect(phoneOut.person.name).toBe('+91•••••3210');
  });

  it('rejects yourself, two targets at once, and malformed addresses', async () => {
    expect(
      (await f.as('dev').post('/friends/requests', { userId: f.ids.dev }).expect(400)).body.error
        .code,
    ).toBe('self');
    await f
      .as('dev')
      .post('/friends/requests', { email: 'a@b.co', phone: '+919876543210' })
      .expect(400);
    await f.as('dev').post('/friends/requests', { email: 'not-an-email' }).expect(400);
    await f.as('dev').post('/friends/requests', { phone: '9876543210' }).expect(400);
  });

  it('limits requests per day', async () => {
    for (let i = 0; i < 20; i++) {
      await f
        .as('spammer')
        .post('/friends/requests', { email: `target${i}@example.com` })
        .expect(202);
    }
    const res = await f
      .as('spammer')
      .post('/friends/requests', { email: 'one-more@example.com' })
      .expect(429);
    expect(res.body.error.code).toBe('rate_limited');
  });
});

describe('friends list and friend-to-friend groups', () => {
  it('includes people from shared groups, flags explicit friends, and hides blocks', async () => {
    const g = await f.newGroup('asha', 'Shared');
    await f.addMember(g, 'mallory');
    await f.addMember(g, 'eve');
    const list = (await f.as('asha').get('/friends')).body as Array<{
      userId: string;
      isFriend: boolean;
      sharesGroup: boolean;
    }>;
    const byId = Object.fromEntries(list.map((x) => [x.userId, x]));
    expect(byId[f.ids.chitra!]).toMatchObject({ isFriend: true, sharesGroup: false });
    expect(byId[f.ids.mallory!]).toMatchObject({ isFriend: false, sharesGroup: true });
    expect(byId[f.ids.eve!]).toBeUndefined(); // eve blocked asha
  });

  it('lets friends open a friend-to-friend group without sharing a group', async () => {
    const res = await f.as('chitra').post('/direct', { userId: f.ids.asha }).expect(200);
    const asha = (await f.as('asha').get('/friends')).body.find(
      (x: { userId: string }) => x.userId === f.ids.chitra,
    );
    expect(asha.directGroupId).toBe(res.body.groupId);
    await f.as('dev').post('/direct', { userId: f.ids.chitra }).expect(404); // neither friends nor group-mates
  });

  it('unfriending removes only the explicit friendship; an open friend-to-friend group stays listed', async () => {
    await f.as('asha').del(`/friends/${f.ids.chitra}`).expect(204);
    expect(await friendIds('asha')).not.toContain(f.ids.chitra);
    const chitra = (await f.as('asha').get('/friends')).body.find(
      (x: { userId: string }) => x.userId === f.ids.chitra,
    );
    expect(chitra).toMatchObject({
      isFriend: false,
      sharesGroup: false,
      directGroupId: expect.any(String),
    });
    // dev and bala were friends with no group at all: unfriending removes them from the list
    await f.as('bala').del(`/friends/${f.ids.dev}`).expect(204);
    const bala = (await f.as('bala').get('/friends')).body.map((x: { userId: string }) => x.userId);
    expect(bala).not.toContain(f.ids.dev);
  });
});
