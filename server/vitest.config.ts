import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // node:sqlite and Fastify are fine in worker threads; keep files isolated (each builds its own app/db).
    pool: 'forks',
  },
});
