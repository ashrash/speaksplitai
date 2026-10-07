import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { InitialSchema1791331200000 } from '../src/database/migrations/1791331200000-InitialSchema.js';

export interface TestDatabase {
  url: string;
  dataSource: DataSource;
  drop(): Promise<void>;
}

/** Creates an empty, uniquely named database and runs every migration against it. */
export async function createMigratedDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    throw new Error('TEST_DATABASE_URL is not set');
  }
  const name = `speaksplit_test_${randomBytes(4).toString('hex')}`;
  await withClient(adminUrl, (c) => c.query(`create database ${name}`));

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const dataSource = new DataSource({
    type: 'postgres',
    url: url.toString(),
    migrations: [InitialSchema1791331200000],
    migrationsTableName: 'typeorm_migrations',
  });
  await dataSource.initialize();
  await dataSource.runMigrations({ transaction: 'each' });

  return {
    url: url.toString(),
    dataSource,
    async drop() {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
      await withClient(adminUrl, (c) => c.query(`drop database if exists ${name} with (force)`));
    },
  };
}

export async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
