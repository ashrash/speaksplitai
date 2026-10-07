import { computeBalances, CURRENCIES, type Ledger, simplifyDebts } from '@speaksplit/split-engine';
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

/** ₹100 paid by A, split three ways as 3334 / 3333 / 3333 unless told otherwise. */
async function insertExpense(
  splits: Array<[string, number]> = [
    [f.members.a, 3334],
    [f.members.b, 3333],
    [f.members.c, 3333],
  ],
  { groupId = f.group, currency = 'INR', total = 10000 } = {},
): Promise<string> {
  const { id } = await one<{ id: string }>(
    `insert into expenses (group_id, description, total_minor, currency, split_type, created_by)
     values ($1, 'Dinner', $3, $4, 'equal', $2) returning id`,
    [groupId, f.users.a, total, currency],
  );
  await client.query(
    'insert into expense_payers (expense_id, group_id, member_id, paid_minor) values ($1, $2, $3, $4)',
    [id, f.group, f.members.a, total],
  );
  for (const [memberId, owed] of splits) {
    await client.query(
      'insert into expense_splits (expense_id, group_id, member_id, owed_minor) values ($1, $2, $3, $4)',
      [id, groupId, memberId, owed],
    );
  }
  return id;
}

/** { memberId: [net, pendingSent] } for one currency. */
async function balances(currency = 'INR') {
  const { rows } = await client.query<{ member_id: string; net: string; pending: string }>(
    `select member_id, net_minor as net, pending_sent_minor as pending
     from member_balances where group_id = $1 and currency = $2`,
    [f.group, currency],
  );
  return Object.fromEntries(rows.map((r) => [r.member_id, [Number(r.net), Number(r.pending)]]));
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
        `update expenses set deleted_at = null, deleted_by = null, total_minor = 12000 where id = $1`,
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
      `insert into settlements (group_id, from_member_id, to_member_id, amount_minor, currency, created_by${extra ? ', ' + extra : ''})
       values ($1, $2, $3, 3333, 'INR', $4${values.map((_, i) => `, $${i + 5}`).join('')})`,
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
  it('nets expenses and confirmed settlements, and shows pending ones separately', async () => {
    await tx(() => insertExpense());
    await tx(() =>
      client.query(
        `insert into settlements (group_id, from_member_id, to_member_id, amount_minor, currency,
                                  status, created_by, confirmed_by, confirmed_at)
         values ($1, $2, $3, 3333, 'INR', 'confirmed', $4, $5, now()),
                ($1, $6, $3, 1000, 'INR', 'pending',   $7, null, null)`,
        [f.group, f.members.b, f.members.a, f.users.b, f.users.a, f.members.c, f.users.c],
      ),
    );
    const b = await balances();
    expect(b[f.members.a]).toEqual([3333, 0]);
    expect(b[f.members.b]).toEqual([0, 0]);
    expect(b[f.members.c]).toEqual([-3333, 1000]);
  });

  it('gives every member a zero row in the group currency before any activity', async () => {
    const b = await balances();
    expect(Object.keys(b)).toHaveLength(3);
    expect(Object.values(b).every(([net]) => net === 0)).toBe(true);
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

describe('multi-currency', () => {
  it('seeds exactly the currencies the split engine knows, with the same minor units', async () => {
    const { rows } = await client.query<{ code: string; minor_unit: number }>(
      'select code, minor_unit from currencies order by code',
    );
    expect(Object.fromEntries(rows.map((r) => [r.code, r.minor_unit]))).toEqual(
      Object.fromEntries(Object.entries(CURRENCIES).map(([c, v]) => [c, v.minorUnit])),
    );
  });

  it('rejects an expense in an unknown currency', async () => {
    expect(await tx(() => insertExpense(undefined, { currency: 'XYZ' }))).toBe('23503');
  });

  it('keeps balances per currency and never adds them together', async () => {
    await tx(() => insertExpense());
    // $30.00 paid by A, split 1000 / 1000 / 1000 cents
    await tx(() =>
      insertExpense(
        [
          [f.members.a, 1000],
          [f.members.b, 1000],
          [f.members.c, 1000],
        ],
        { currency: 'USD', total: 3000 },
      ),
    );
    const inr = await balances('INR');
    const usd = await balances('USD');
    expect(inr[f.members.a]![0]).toBe(6666);
    expect(usd[f.members.a]![0]).toBe(2000);
    expect(usd[f.members.b]![0]).toBe(-1000);
    for (const b of [inr, usd]) {
      expect(Object.values(b).reduce((sum, [net]) => sum + net!, 0)).toBe(0);
    }
  });

  it('settles a USD debt with an INR UPI payment', async () => {
    await tx(() =>
      insertExpense(
        [
          [f.members.a, 1000],
          [f.members.b, 1000],
          [f.members.c, 1000],
        ],
        { currency: 'USD', total: 3000 },
      ),
    );
    const code = await tx(() =>
      client.query(
        `insert into settlements (group_id, from_member_id, to_member_id, amount_minor, currency,
                                  paid_amount_minor, paid_currency, method, status, created_by,
                                  confirmed_by, confirmed_at)
         values ($1, $2, $3, 1000, 'USD', 83123, 'INR', 'upi', 'confirmed', $4, $5, now())`,
        [f.group, f.members.b, f.members.a, f.users.b, f.users.a],
      ),
    );
    expect(code).toBeNull();
    const usd = await balances('USD');
    expect(usd[f.members.b]![0]).toBe(0);
    expect(usd[f.members.a]![0]).toBe(1000);
    // the INR side records what moved but doesn't create an INR balance
    expect(Object.values(await balances('INR')).every(([net]) => net === 0)).toBe(true);
  });

  const settleRaw = (cols: string, vals: string) =>
    client.query(
      `insert into settlements (group_id, from_member_id, to_member_id, created_by, ${cols})
       values ($1, $2, $3, $4, ${vals})`,
      [f.group, f.members.b, f.members.a, f.users.b],
    );

  it('only allows UPI for INR payments', async () => {
    expect(await tx(() => settleRaw(`amount_minor, currency, method`, `1000, 'USD', 'upi'`))).toBe(
      '23514',
    );
    expect(
      await tx(() => settleRaw(`amount_minor, currency, method`, `1000, 'USD', 'cash'`)),
    ).toBeNull();
  });

  it('requires paid amount and currency together, and a different currency', async () => {
    const cols = 'amount_minor, currency, method, paid_amount_minor, paid_currency';
    expect(await tx(() => settleRaw(cols, `1000, 'USD', 'cash', 900, null`))).toBe('23514');
    expect(await tx(() => settleRaw(cols, `1000, 'USD', 'cash', 900, 'USD'`))).toBe('23514');
  });

  it('stores amounts beyond 32-bit range exactly', async () => {
    // Rp 50,000,000.00 = 5,000,000,000 minor units (IDR has 2 decimals)
    const total = 5_000_000_000;
    expect(
      await tx(() =>
        insertExpense(
          [
            [f.members.a, 1_666_666_668],
            [f.members.b, 1_666_666_666],
            [f.members.c, 1_666_666_666],
          ],
          { currency: 'IDR', total },
        ),
      ),
    ).toBeNull();
    expect((await balances('IDR'))[f.members.a]![0]).toBe(3_333_333_332);
  });
});

describe('split engine agrees with the database', () => {
  it('computes the same per-currency balances as member_balances', async () => {
    await tx(() => insertExpense());
    await tx(() =>
      insertExpense(
        [
          [f.members.b, 2000],
          [f.members.c, 1000],
        ],
        { currency: 'USD', total: 3000 },
      ),
    );
    await tx(() =>
      client.query(
        `insert into settlements (group_id, from_member_id, to_member_id, amount_minor, currency,
                                  status, created_by, confirmed_by, confirmed_at)
         values ($1, $2, $3, 1000, 'INR', 'confirmed', $4, $5, now()),
                ($1, $6, $3, 500,  'USD', 'pending',   $7, null, null),
                ($1, $6, $3, 300,  'INR', 'cancelled', $7, null, null)`,
        [f.group, f.members.b, f.members.a, f.users.b, f.users.a, f.members.c, f.users.c],
      ),
    );

    // Load the raw ledger the way the API will, and run the engine on it
    const { rows: expenses } = await client.query<{ id: string; currency: string }>(
      'select id, currency from expenses where group_id = $1 and deleted_at is null',
      [f.group],
    );
    const ledger: Ledger = { expenses: [], settlements: [] };
    for (const e of expenses) {
      const payers = await client.query<{ member_id: string; paid_minor: string }>(
        'select member_id, paid_minor from expense_payers where expense_id = $1',
        [e.id],
      );
      const splits = await client.query<{ member_id: string; owed_minor: string }>(
        'select member_id, owed_minor from expense_splits where expense_id = $1',
        [e.id],
      );
      ledger.expenses.push({
        currency: e.currency,
        payers: payers.rows.map((r) => ({
          memberId: r.member_id,
          paidMinor: Number(r.paid_minor),
        })),
        splits: splits.rows.map((r) => ({
          memberId: r.member_id,
          owedMinor: Number(r.owed_minor),
        })),
      });
    }
    const { rows: settlements } = await client.query<{
      currency: string;
      from_member_id: string;
      to_member_id: string;
      amount_minor: string;
      status: 'pending' | 'confirmed' | 'disputed' | 'cancelled';
    }>(
      'select currency, from_member_id, to_member_id, amount_minor, status from settlements where group_id = $1',
      [f.group],
    );
    ledger.settlements = settlements.map((r) => ({
      currency: r.currency,
      fromMemberId: r.from_member_id,
      toMemberId: r.to_member_id,
      amountMinor: Number(r.amount_minor),
      status: r.status,
    }));

    const { rows: view } = await client.query<Record<string, string>>(
      `select member_id, currency, paid_minor, owed_minor, net_minor, pending_sent_minor, pending_received_minor
       from member_balances
       where group_id = $1 and (paid_minor <> 0 or owed_minor <> 0 or net_minor <> 0
                                or pending_sent_minor <> 0 or pending_received_minor <> 0)
       order by currency, member_id`,
      [f.group],
    );
    const fromView = view.map((r) => ({
      memberId: r.member_id,
      currency: r.currency,
      paidMinor: Number(r.paid_minor),
      owedMinor: Number(r.owed_minor),
      netMinor: Number(r.net_minor),
      pendingSentMinor: Number(r.pending_sent_minor),
      pendingReceivedMinor: Number(r.pending_received_minor),
    }));
    const fromEngine = computeBalances(ledger).filter(
      (b) =>
        b.paidMinor || b.owedMinor || b.netMinor || b.pendingSentMinor || b.pendingReceivedMinor,
    );
    const byKey = (
      a: { currency: string; memberId: string },
      b: { currency: string; memberId: string },
    ) => a.currency.localeCompare(b.currency) || a.memberId.localeCompare(b.memberId);
    expect(fromEngine.sort(byKey)).toEqual(fromView.sort(byKey));

    // and the simplified plan from the view's balances settles everyone
    const plan = simplifyDebts(fromView);
    expect(plan.length).toBeGreaterThan(0);
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
