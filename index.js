#!/usr/bin/env node
/**
 * Root launcher. Thin wrapper that delegates to the CLI in src/index.js so the
 * package can be started from the repo root (`node index.js --mode=DRY_RUN`).
 */
import { main } from './src/index.js';

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exitCode = 1;
});
