import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';

/**
 * Hand-written migrations are the source of truth for the schema;
 * never let TypeORM synchronize.
 */
export function typeormOptions(databaseUrl: string): DataSourceOptions {
  return {
    type: 'postgres',
    url: databaseUrl,
    synchronize: false,
    migrationsRun: false,
    entities: [join(import.meta.dirname, '..', '**', '*.entity.js')],
    migrations: [join(import.meta.dirname, 'migrations', '*.js')],
    migrationsTableName: 'typeorm_migrations',
  };
}
