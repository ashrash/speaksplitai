import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Integration tests against a real PostgreSQL. Needs TEST_DATABASE_URL pointing at a role that
// may create databases; each run creates and drops its own throwaway database.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.int.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
