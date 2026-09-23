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
import { configureGateThreshold } from '../scoring/explainScore.js';
import { normalizeProfile } from '../profile/model.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Repo root is two levels up from src/config — unless JOB_AGENT_ROOT names a
 * different workspace (config/, data/, logs/, resumes/ ...). The test suite
 * sets it to a throwaway copy so it never reads a developer's real profile or
 * master resume, nor writes to their real database.
 */
export const PROJECT_ROOT = process.env.JOB_AGENT_ROOT
  ? resolve(process.env.JOB_AGENT_ROOT)
  : resolve(__dirname, '..', '..');

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
 * Find keys that appear more than once in the same JSON object.
 *
 * `JSON.parse` silently keeps the LAST of a repeated key and discards the rest,
 * and it does so before any validation runs — Ajv never sees that anything was
 * dropped, because by then the key is gone. `config/scoring.json` defined
 * `evidenceAliases.streaming` twice, so one of the two alias lists was thrown
 * away on every load with nothing reporting it.
 *
 * This has to scan the SOURCE TEXT. A `JSON.parse` reviver is no use: it runs
 * after the parser has already collapsed the duplicate, so it only ever sees
 * the surviving value. The scanner below walks the raw string, tracks object
 * nesting, and records a key the second time it is declared in the same object.
 *
 * @param {string} raw JSON source text
 * @returns {string[]} duplicated key names, with their object path
 */
function duplicateKeys(raw) {
  const dupes = new Set();
  /** Stack of { keys:Set, path:string } — one frame per open object. */
  const stack = [];
  /** Key most recently read at the current level, so nested frames can be named. */
  let lastKey = null;
  let i = 0;

  /** Read a JSON string literal starting at the opening quote; returns its value. */
  const readString = () => {
    let out = '';
    i += 1; // opening quote
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === '\\') { out += raw[i + 1] ?? ''; i += 2; continue; }
      if (ch === '"') { i += 1; return out; }
      out += ch;
      i += 1;
    }
    return out;
  };

  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      const value = readString();
      // A string is a KEY when the next non-space character is a colon.
      let j = i;
      while (j < raw.length && /\s/.test(raw[j])) j += 1;
      if (raw[j] === ':' && stack.length) {
        const frame = stack[stack.length - 1];
        if (frame.keys.has(value)) dupes.add(frame.path ? `${frame.path}.${value}` : value);
        frame.keys.add(value);
        lastKey = value;
      }
      continue;
    }
    if (ch === '{') {
      const parent = stack[stack.length - 1];
      const path = parent ? (parent.path ? `${parent.path}.${lastKey}` : lastKey) : '';
      stack.push({ keys: new Set(), path: path ?? '' });
      lastKey = null;
    } else if (ch === '}') {
      stack.pop();
    }
    i += 1;
  }
  return [...dupes];
}

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
    throw new Error(`Config file not found or unreadable: ${filePath} (${err.code || err.message})`, { cause: err });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config file is not valid JSON: ${filePath} - ${err.message}`, { cause: err });
  }
  // Fail loudly rather than silently using whichever copy happened to be last.
  const dupes = duplicateKeys(raw);
  if (dupes.length) {
    throw new Error(
      `Config file has duplicate key(s): ${filePath} - ${dupes.map((k) => `"${k}"`).join(', ')}. `
      + 'JSON.parse keeps only the last occurrence and silently discards the others, '
      + 'so merge them into a single entry.',
    );
  }
  return parsed;
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
    // quiet: dotenv >= 17 prints an "injected env" banner to STDOUT by
    // default, which would corrupt `doctor --json` and every piped command.
    dotenv.config({ path: join(root, '.env'), quiet: true });
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

  // The ACTIVE SEARCH PROFILE, when one has been activated.
  //
  // Nothing in the pipeline reads this: candidate.json, scoring.json and
  // exclusions.json are REGENERATED from the profile at activation time
  // (src/profile/store.js), which is what lets every existing consumer stay
  // unchanged. It is surfaced here so the dashboard and the CLI can say WHOSE
  // search is running and offer to switch it — a run that silently uses the
  // previous candidate's titles is the failure this whole model exists to
  // prevent, and it can only be reported if the answer is loaded.
  //
  // Read inline rather than through src/profile/store.js, which imports this
  // module for `readJson` and would form a cycle. Never fatal: a missing or
  // corrupt profile leaves the pipeline running on the config files as written.
  bundle.profile = readActiveProfile(root);

  // Consumers that only ever see a DB row (the dashboard data layer, the
  // auto-apply precheck) derive "was this downgraded by the sponsorship gate?"
  // from tier + score, because the flag is not a stored column. They need the
  // real Apply threshold: with it hardcoded, editing scoring.tiers.apply
  // silently misclassified fit for every gated row. Every entry point funnels
  // through loadConfig, so setting it here keeps the derivation honest
  // everywhere without threading config into pure functions.
  configureGateThreshold(bundle.scoring?.tiers?.apply);

  return Object.freeze(bundle);
}

/**
 * The active profile, or null. Best effort by design — see `loadConfig`.
 *
 * @param {string} root project root
 * @returns {object|null} normalized profile
 */
export function readActiveProfile(root) {
  try {
    const pointer = join(root, 'config', 'profiles', '_active.json');
    const id = readJson(pointer)?.id;
    if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(String(id))) return null;
    return normalizeProfile(readJson(join(root, 'config', 'profiles', `${id}.json`)));
  } catch {
    return null;
  }
}
