/**
 * Config loader.
 *
 * Loads .env (via dotenv), reads + parses each JSON config file, validates each
 * against its schema, and returns a single immutable config bundle. Fails loudly
 * on missing files, JSON syntax errors, or schema violations.
 *
 * Configs are the SOURCE OF TRUTH at runtime; nothing here reads prompt text.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { SCHEMA_FILES, createValidator, assertValidConfig } from './validateConfig.js';
import { getRuntimeSettings } from '../utils/credentialManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root is two levels up from src/config. */
export const PROJECT_ROOT = resolve(__dirname, '..', '..');

/** Config files (logical name -> filename under config/). */
export const CONFIG_FILES = {
  candidate: 'candidate.json',
  scoring: 'scoring.json',
  exclusions: 'exclusions.json',
  jobboards: 'jobboards.json',
  screeningAnswers: 'screening_answers.json',
  humanizerPatterns: 'humanizer_patterns.json',
  coverLetter: 'cover_letter.json',
  atsResume: 'ats_resume.json',
};

/** Which config names have a schema and must be validated. */
const VALIDATED = Object.keys(SCHEMA_FILES);

/**
 * Read and parse a JSON file, throwing a clear error on failure.
 * @param {string} filePath
 * @returns {any}
 */
export function readJson(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Config file not found or unreadable: ${filePath} (${err.code || err.message})`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config file is not valid JSON: ${filePath} - ${err.message}`);
  }
}

/**
 * Load, validate, and bundle all configuration.
 *
 * @param {object} [options]
 * @param {string} [options.root=PROJECT_ROOT] project root directory
 * @param {boolean} [options.loadEnv=true] load .env into process.env
 * @param {NodeJS.ProcessEnv} [options.env=process.env]
 * @returns {{
 *   candidate: object, scoring: object, exclusions: object, jobboards: object,
 *   screeningAnswers: object, humanizerPatterns: object,
 *   runtime: ReturnType<typeof getRuntimeSettings>, root: string
 * }}
 */
export function loadConfig({ root = PROJECT_ROOT, loadEnv = true, env = process.env } = {}) {
  if (loadEnv) {
    dotenv.config({ path: join(root, '.env') });
  }

  const configDir = join(root, 'config');
  const schemaDir = join(configDir, 'schemas');

  // Read every config file.
  /** @type {Record<string, any>} */
  const bundle = {};
  for (const [name, file] of Object.entries(CONFIG_FILES)) {
    bundle[name] = readJson(join(configDir, file));
  }

  // Validate the ones with schemas using a shared Ajv instance.
  const ajv = createValidator();
  for (const name of VALIDATED) {
    const schema = readJson(join(schemaDir, SCHEMA_FILES[name]));
    assertValidConfig(name, bundle[name], schema, { ajv });
  }

  bundle.runtime = getRuntimeSettings(env);
  bundle.root = root;
  return Object.freeze(bundle);
}
