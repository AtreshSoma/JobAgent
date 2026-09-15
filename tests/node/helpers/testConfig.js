/**
 * The config bundle every test should read.
 *
 * Why this exists
 * ---------------
 * Tests used to call `loadConfig()` directly, which reads `config/candidate.json`
 * and `config/screening_answers.json` — gitignored files holding one real
 * person's name, contact details, work authorization, salary and EEO answers.
 * Two things followed from that:
 *
 *   1. Assertions encoded personal data. `loadConfig.test.js` asserted
 *      the author's own `fullName`; `coverLetter.test.js` expected an
 *      H-1B sentence; `discoveryCoverage.test.js` expected a specific target
 *      title. None of those can pass for any other user, and they turned the
 *      suite red the moment the local config became a placeholder.
 *   2. The suite could not run at all on a clean clone, because those files do
 *      not exist there.
 *
 * `loadTestConfig()` keeps the repository's SHARED configuration (scoring,
 * exclusions, jobboards, cover-letter template, humanizer patterns — all
 * tracked, all genuinely under test) and swaps in the fictional candidate and
 * screening answers from `tests/node/fixtures/config/`. Tests therefore assert
 * against a profile the repository owns, and the result is identical on every
 * machine.
 *
 * A test that genuinely needs to check the REAL local config should assert its
 * SHAPE, never its values — see `loadConfig.test.js`.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, readJson } from '../../../src/config/loadConfig.js';
import { SCHEMA_FILES, createValidator, assertValidConfig } from '../../../src/config/validateConfig.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** tests/node/fixtures/config */
export const FIXTURE_CONFIG_DIR = join(HERE, '..', 'fixtures', 'config');
/** Repo root. */
const ROOT = join(HERE, '..', '..', '..');

/** The fictional candidate profile the whole suite runs against. */
export const fixtureCandidate = readJson(join(FIXTURE_CONFIG_DIR, 'candidate.json'));
/** The fictional screening answers the whole suite runs against. */
export const fixtureScreeningAnswers = readJson(join(FIXTURE_CONFIG_DIR, 'screening_answers.json'));

// Validate the fixtures against the same schemas the real configs must satisfy.
// A fixture that has drifted out of schema would otherwise fail obscurely, deep
// inside whichever test happened to touch the changed field first.
{
  const ajv = createValidator();
  assertValidConfig('candidate', fixtureCandidate,
    readJson(join(ROOT, 'config', 'schemas', SCHEMA_FILES.candidate)), { ajv });
}

/**
 * Load the shared repo configuration with the fixture profile substituted in.
 *
 * @param {object} [options] forwarded to `loadConfig`
 * @returns {ReturnType<typeof loadConfig>} frozen bundle
 */
export function loadTestConfig({ loadEnv = false, env = {}, ...rest } = {}) {
  const real = loadConfig({ loadEnv, env, ...rest });
  return Object.freeze({
    ...real,
    candidate: fixtureCandidate,
    screeningAnswers: fixtureScreeningAnswers,
  });
}
