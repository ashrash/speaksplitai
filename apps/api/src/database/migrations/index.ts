import { InitialSchema1791331200000 } from './1791331200000-InitialSchema.js';
import { Friends1791400000000 } from './1791400000000-Friends.js';

/** Every migration, in order. Listed explicitly so tests, the app and the CLI share one list. */
export const MIGRATIONS = [InitialSchema1791331200000, Friends1791400000000];
