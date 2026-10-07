import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { TestApp } from './app.js';

/** Named test users with tokens, plus helpers that act as them or set up data directly. */
export function fixtures(t: TestApp) {
  const http = t.app.getHttpServer();
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const sql = (text: string, params: unknown[] = []) => t.db.dataSource.query(text, params);

  async function user(name: string): Promise<string> {
    tokens[name] = await t.token(`auth0|${name}`, { name });
    ids[name] = (await as(name).get('/me').expect(200)).body.id;
    return ids[name]!;
  }

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

  async function newGroup(owner: string, name = 'Trip'): Promise<string> {
    return (await as(owner).post('/groups', { name }).expect(201)).body.id;
  }

  /** Adds a user straight into a group (bypassing invites). */
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

  /** Member `payerMember` paid `amount` that member `owesMember` owes in full. Takes member ids. */
  async function expenseBetween(
    groupId: string,
    payerMember: string,
    owesMember: string,
    amount: number,
    currency = 'INR',
  ) {
    const runner = t.db.dataSource.createQueryRunner();
    await runner.startTransaction();
    const [e] = await runner.query(
      `insert into expenses (group_id, description, total_minor, currency, split_type, created_by)
       values ($1, 'Dinner', $2, $3, 'exact', (select created_by from groups where id = $1)) returning id`,
      [groupId, amount, currency],
    );
    await runner.query(
      'insert into expense_payers (expense_id, group_id, member_id, paid_minor) values ($1, $2, $3, $4)',
      [e.id, groupId, payerMember, amount],
    );
    await runner.query(
      'insert into expense_splits (expense_id, group_id, member_id, owed_minor) values ($1, $2, $3, $4)',
      [e.id, groupId, owesMember, amount],
    );
    await runner.commitTransaction();
    await runner.release();
  }

  /** `payer` paid `amount` for `owes` (user names): owes ends up owing payer `amount`. */
  async function expense(
    groupId: string,
    payer: string,
    owes: string,
    amount: number,
    currency = 'INR',
  ) {
    await expenseBetween(
      groupId,
      await memberId(groupId, payer),
      await memberId(groupId, owes),
      amount,
      currency,
    );
  }

  async function settle(
    groupId: string,
    from: string,
    to: string,
    amount: number,
    currency = 'INR',
  ) {
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

  return {
    tokens,
    ids,
    sql,
    user,
    as,
    newGroup,
    addMember,
    memberId,
    expense,
    expenseBetween,
    settle,
  };
}
