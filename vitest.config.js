import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/node/**/*.test.js'],
    environment: 'node',
    // Seeds config/candidate.json, config/screening_answers.json and the master
    // resume from their tracked .example files when absent. Those files are
    // gitignored (PII), and ~24 test files call loadConfig() at module scope —
    // without this a fresh clone cannot COLLECT 27 of 96 test files, which is
    // what kept CI red on main. Never overwrites a real local config.
    globalSetup: ['tests/node/globalSetup.js'],
  },
});
