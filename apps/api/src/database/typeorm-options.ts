import type { DataSourceOptions } from 'typeorm';
import { ENTITIES } from './entities/index.js';
import { MIGRATIONS } from './migrations/index.js';
import { SnakeNamingStrategy } from './naming.js';

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
    entities: ENTITIES,
    migrations: MIGRATIONS,
    migrationsTableName: 'typeorm_migrations',
    namingStrategy: new SnakeNamingStrategy(),
  };
}
