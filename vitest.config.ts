import { defineConfig } from 'vitest/config';

/** `npm test` runs every workspace's own vitest.config.ts as a project. */
export default defineConfig({
  test: {
    projects: ['shared', 'server', 'web'],
  },
});
