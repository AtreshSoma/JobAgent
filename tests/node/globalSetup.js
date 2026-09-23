/**
 * Vitest globalSetup: make a clean clone testable.
 *
 * ~24 test files call `loadConfig()` at module scope. The configs they read are
 * gitignored (they hold PII), so on a fresh checkout those files failed to
 * COLLECT — not to assert — and 353 tests silently never ran. CI executed
 * `npm test` on a bare checkout, so this is why `main` was red while the
 * author's machine was green.
 *
 * Seeding the example files here (never overwriting a real local config) is the
 * smallest change that makes the checked-out repository self-sufficient. It runs
 * once per suite, before any test file is collected.
 */

import { materializeLocalFiles } from '../../scripts/setupLocalConfig.mjs';

export default function setup() {
  // Many test files boot a dashboard on the REPO root in parallel; the
  // cross-process run lock (src/utils/runLock.js) would make those unrelated
  // servers 409 each other. Tests that exercise the lock opt back in.
  process.env.JOB_AGENT_RUN_LOCK = 'off';
  const { created, missingExample } = materializeLocalFiles();

  if (missingExample.length) {
    throw new Error(
      `Example fixtures missing from the repository: ${missingExample.join(', ')}. `
      + 'Tests cannot run without them.',
    );
  }
  if (created.length) {
    console.log(`[globalSetup] seeded from examples: ${created.join(', ')}`);
  }
}
