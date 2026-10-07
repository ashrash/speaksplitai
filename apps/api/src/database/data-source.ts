import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { typeormOptions } from './typeorm-options.js';

// Entry point for the TypeORM CLI (`pnpm migration:run`), which runs against the built JS.
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set');
}

export default new DataSource(typeormOptions(url));
