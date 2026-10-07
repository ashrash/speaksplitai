import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type TestDatabase } from './db.js';

// Replays the schema's verification checklist: every invariant the database itself must enforce.

let db: TestDatabase;
let client: pg.Client;

interface Fixture {
  users: { a: string; b: string; c: string };
  group: string;
  members: { a: string; b: string; c: string };
  otherGroup: string;
  otherMember: string;
}
let f: Fixture;

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await client.query(sql, params);
  return rows[0] as T;
}

/** Runs statements in one transaction; resolves to the SQLSTATE it failed with, or null. */
async function tx(fn: () => Promise<unknown>): Promise<string | null> {
  await client.query('begin');
  try {
    await fn();
    await client.query('commit');
    return null;
  } catch (err) {
    await client.query('rollback');
    return (err as { code?: string }).code ?? 'unknown';
  }
}

async function insertUser(name: string): Promise<string> {
  const row = await one<{ id: string }>(
    'insert into users (auth_subject, name) values ($1, $2) returning id',
    [`auth0|${name}-${Math.random()}`, name],
  );
  return row.id;
}

async function insertGroup(createdBy: string): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into groups (name, created_by) values ('Goa trip', $1) returning id`,
    [createdBy],
  );
  return row.id;
}

async function insertMember(groupId: string, userId: string, role = 'member'): Promise<string> {
  const row = await one<{ id: string }>(
    'insert into group_members (group_id, user_id, role) values ($1, $2, $3) returning id',
    [groupId, userId, role],
  );
  return row.id;
}

/** ₹100 paid by A, split three ways as 3334 / 3333 / 3333 unless splits are given. */
async function insertExpense(
  splits: Array<[string, number]> = [
    [f.members.a, 3334],
    [f.members.b, 3333],
    [f.members.c, 3333],
  ],
  groupId = f.group,
): Promise<string> {
  const { id } = await one<{ id: string }>(
    `insert into expenses (group_id, description, total_paise, split_type, created_by)
     values ($1, 'Dinner', 10000, 'equal', $2) returning id`,
    [groupId, f.users.a],
  );
  await client.query(
    'insert into expense_payers (expense_id, group_id, member_id, paid_paise) values ($1, $2, $3, 10000)',
    [id, f.group, f.members.a],
  );
  for (const [memberId, owed] of splits) {
    await client.query(
      'insert into expense_splits (expense_id, group_id, member_id, owed_paise) values ($1, $2, $3, $4)',
      [id, groupId, memberId, owed],
    );
  }
  return id;
}

beforeAll(async () => {
  db = await createMigratedDatabase();
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
  await db?.drop();
});

beforeEach(async () => {
  await client.query(
    'truncate users, groups, audit_log, idempotency_keys restart identity cascade',
  );
  const a = await insertUser('Asha');
  const b = await insertUser('Bala');
  const c = await insertUser('Chitra');
  const group = await insertGroup(a);
  const otherGroup = await insertGroup(a);
  f = {
    users: { a, b, c },
    group,
    members: {
      a: await insertMember(group, a, 'owner'),
      b: await insertMember(group, b),
      c: await insertMember(group, c),
    },
    otherGroup,
    otherMember: await insertMember(otherGroup, b),
  };
});

describe('expense totals (deferred constraint trigger)', () => {
  it('accepts splits that sum exactly to the total', async () => {
    expect(await tx(() => insertExpense())).toBeNull();
  });

  it('rejects splits that are a paisa short, at commit', async () => {
    const code = await tx(() =>
      insertExpense([
        [f.members.a, 3333],
        [f.members.b, 3333],
        [f.members.c, 3333],
      ]),
    );
    expect(code).toBe('23514');
  });

  it('rejects restoring an expense whose total no longer matches', async () => {
    let id = '';
    await tx(async () => (id = await insertExpense()));
    await tx(() =>
      client.query(`update expenses set deleted_at = now(), deleted_by = $2 where id = $1`, [
        id,
        f.users.a,
      ]),
    );
    const code = await tx(() =>
      client.query(
        `update expenses set deleted_at = null, deleted_by = null, total_paise = 12000 where id = $1`,
        [id],
      ),
    );
    expect(code).toBe('23514');
  });
});

describe('group isolation', () => {
  it('rejects a split for a member of another group', async () => {
    const code = await tx(() =>
      insertExpense([
        [f.members.a, 5000],
        [f.otherMember, 5000],
      ]),
    );
    expect(code).toBe('23503');
  });
});

describe('membership', () => {
  it('allows only one active owner per group', async () => {
    const code = await tx(() =>
      client.query(`update group_members set role = 'owner' where id = $1`, [f.members.b]),
    );
    expect(code).toBe('23505');
  });

  it('does not let a placeholder be the owner', async () => {
    const code = await tx(() =>
      client.query(
        `insert into group_members (group_id, placeholder_name, role) values ($1, 'Dev', 'owner')`,
        [f.otherGroup],
      ),
    );
    expect(code).toBe('23514');
  });

  it('rejects hard-deleting a single member', async () => {
    const code = await tx(() =>
      client.query('delete from group_members where id = $1', [f.members.c]),
    );
    expect(code).toBe('23001');
  });

  it('cascades when the whole group is deleted', async () => {
    await tx(() => insertExpense());
    expect(await tx(() => client.query('delete from groups where id = $1', [f.group]))).toBeNull();
    const { n } = await one<{ n: string }>(
      'select count(*) as n from group_members where group_id = $1',
      [f.group],
    );
    expect(Number(n)).toBe(0);
  });
});

describe('settlements', () => {
  const settle = (from: string, to: string, extra = '', values: unknown[] = []) =>
    client.query(
      `insert into settlements (group_id, from_member_id, to_member_id, amount_paise, created_by${extra ? ', ' + extra : ''})
       values ($1, $2, $3, 3333, $4${values.map((_, i) => `, $${i + 5}`).join('')})`,
      [f.group, from, to, f.users.b, ...values],
    );

  it('rejects paying yourself', async () => {
    expect(await tx(() => settle(f.members.b, f.members.b))).toBe('23514');
  });

  it('requires confirmed_at when confirmed', async () => {
    expect(await tx(() => settle(f.members.b, f.members.a, 'status', ['confirmed']))).toBe('23514');
  });

  it('rejects the same UPI reference twice in a group', async () => {
    expect(await tx(() => settle(f.members.b, f.members.a, 'upi_ref', ['AXIS123456']))).toBeNull();
    expect(await tx(() => settle(f.members.c, f.members.a, 'upi_ref', ['AXIS123456']))).toBe(
      '23505',
    );
  });
});

describe('member_balances view', () => {
  const balances = async () => {
    const { rows } = await client.query<{ member_id: string; net: string; pending: string }>(
      `select member_id, net_paise as net, pending_sent_paise as pending
       from member_balances where group_id = $1`,
      [f.group],
    );
    return Object.fromEntries(rows.map((r) => [r.member_id, [Number(r.net), Number(r.pending)]]));
  };

  it('nets expenses and confirmed settlements, and shows pending ones separately', async () => {
    await tx(() => insertExpense());
    await tx(() =>
      client.query(
        `insert into settlements (group_id, from_member_id, to_member_id, amount_paise, status,
                                  created_by, confirmed_by, confirmed_at)
         values ($1, $2, $3, 3333, 'confirmed', $4, $5, now()),
                ($1, $6, $3, 1000, 'pending',   $7, null, null)`,
        [f.group, f.members.b, f.members.a, f.users.b, f.users.a, f.members.c, f.users.c],
      ),
    );
    const b = await balances();
    expect(b[f.members.a]).toEqual([3333, 0]);
    expect(b[f.members.b]).toEqual([0, 0]);
    expect(b[f.members.c]).toEqual([-3333, 1000]);
  });

  it('drops soft-deleted expenses', async () => {
    let id = '';
    await tx(async () => (id = await insertExpense()));
    await tx(() =>
      client.query(`update expenses set deleted_at = now(), deleted_by = $2 where id = $1`, [
        id,
        f.users.a,
      ]),
    );
    const b = await balances();
    expect(Object.values(b).every(([net]) => net === 0)).toBe(true);
  });
});

describe('check constraints', () => {
  it.each([
    ['invalid VPA', `insert into user_upi_ids (user_id, vpa) values ($1, 'not a vpa')`],
    ['invalid phone', `update users set phone = '98765' where id = $1`],
  ])('rejects %s', async (_label, sql) => {
    expect(await tx(() => client.query(sql, [f.users.a]))).toBe('23514');
  });

  it('rejects an unattached upload without an expiry', async () => {
    const code = await tx(() =>
      client.query(
        `insert into attachments (uploaded_by, kind, storage_key, mime_type, size_bytes)
         values ($1, 'receipt', 'k/1', 'image/jpeg', 100)`,
        [f.users.a],
      ),
    );
    expect(code).toBe('23514');
  });

  it('allows only one primary UPI ID per user', async () => {
    const add = (vpa: string) =>
      client.query(`insert into user_upi_ids (user_id, vpa, is_primary) values ($1, $2, true)`, [
        f.users.a,
        vpa,
      ]);
    expect(await tx(() => add('asha@okaxis'))).toBeNull();
    expect(await tx(() => add('asha@ybl'))).toBe('23505');
  });
});

describe('audit_log', () => {
  it('is append-only', async () => {
    await client.query(
      `insert into audit_log (group_id, entity, entity_id, actor_id, action)
       values ($1, 'group', $1, $2, 'create')`,
      [f.group, f.users.a],
    );
    expect(await tx(() => client.query(`update audit_log set action = 'delete'`))).toBe('42501');
    expect(await tx(() => client.query('delete from audit_log'))).toBe('42501');
  });
});

describe('migration', () => {
  it('reverts cleanly and re-applies', async () => {
    await db.dataSource.undoLastMigration({ transaction: 'each' });
    const { n } = await one<{ n: string }>(
      `select count(*) as n from pg_tables where schemaname = 'public' and tablename <> 'typeorm_migrations'`,
    );
    expect(Number(n)).toBe(0);
    await db.dataSource.runMigrations({ transaction: 'each' });
  });
});
