import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { typeormOptions } from '../src/database/typeorm-options.js';
import { createMigratedDatabase, type TestDatabase } from './db.js';

// Entities mirror the migration and never generate schema, so check they agree: every entity
// column must exist with the same type and nullability.

let db: TestDatabase;
let ds: DataSource;

beforeAll(async () => {
  db = await createMigratedDatabase();
  ds = await new DataSource(typeormOptions(db.url)).initialize();
});

afterAll(async () => {
  await ds?.destroy();
  await db?.drop();
});

/** TypeORM column type -> Postgres udt_name. */
function udt(type: unknown): string {
  if (type === Number) return 'int4';
  if (type === String) return 'varchar';
  if (type === Boolean) return 'bool';
  if (type === Date) return 'timestamp';
  const map: Record<string, string> = {
    uuid: 'uuid',
    text: 'text',
    citext: 'citext',
    char: 'bpchar',
    smallint: 'int2',
    integer: 'int4',
    int: 'int4',
    int4: 'int4',
    bigint: 'int8',
    boolean: 'bool',
    timestamptz: 'timestamptz',
    date: 'date',
    numeric: 'numeric',
    jsonb: 'jsonb',
    bytea: 'bytea',
  };
  return map[String(type)] ?? `unknown:${String(type)}`;
}

describe('entities match the migrated schema', () => {
  it('every entity column exists with the same type and nullability', async () => {
    const columns = await ds.query<
      Array<{ table_name: string; column_name: string; udt_name: string; is_nullable: string }>
    >(
      `select table_name, column_name, udt_name, is_nullable
       from information_schema.columns where table_schema = 'public'`,
    );
    const actual = new Map(columns.map((c) => [`${c.table_name}.${c.column_name}`, c]));
    const problems: string[] = [];
    for (const entity of ds.entityMetadatas) {
      for (const col of entity.columns) {
        const key = `${entity.tableName}.${col.databaseName}`;
        const db = actual.get(key);
        if (!db) {
          problems.push(`${key}: missing in the database`);
          continue;
        }
        const expected = udt(col.type);
        if (db.udt_name !== expected)
          problems.push(`${key}: entity ${expected}, database ${db.udt_name}`);
        if ((db.is_nullable === 'YES') !== col.isNullable) {
          problems.push(
            `${key}: entity nullable=${col.isNullable}, database nullable=${db.is_nullable === 'YES'}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
