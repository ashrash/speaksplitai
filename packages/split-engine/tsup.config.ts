import { defineConfig } from 'tsup';

// Dual CJS + ESM output: the NestJS API loads CommonJS, while Vite and Metro prefer ESM.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
});
