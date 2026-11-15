/**
 * The product version, read from package.json so it is written in one place
 * (audit X6). `npm run verify` checks that the lockfile and the newest
 * changelog entry agree with it.
 */
import { readFileSync } from 'node:fs';

export const PACKAGE_VERSION = String(
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0',
);
