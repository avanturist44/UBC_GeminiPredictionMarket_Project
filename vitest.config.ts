import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 20_000,
    // Each database suite boots a WASM Postgres instance and applies migrations.
    maxWorkers: 4,
    hookTimeout: 30_000,
  },
});
