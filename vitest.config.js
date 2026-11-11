import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/node/**/*.test.js'],
    environment: 'node',
    // Builds a throwaway workspace (shared config + the fictional fixture
    // profile + the synthetic example resume) and points JOB_AGENT_ROOT at it,
    // so no test reads the developer's real candidate.json / master resume or
    // writes to their real data/applied_jobs.db — and a clean clone, which has
    // none of those gitignored files, runs exactly the same suite.
    globalSetup: ['tests/node/globalSetup.js'],
  },
});
