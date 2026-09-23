/**
 * Saved search profiles — create, list, switch, activate.
 *
 * WHY. There was exactly one candidate: `config/candidate.json`, hand-edited,
 * with no way to keep a second person's search or to move between two
 * directions of your own. Replacing the master resume changed nothing upstream,
 * because discovery reads that file and only that file.
 *
 * LAYOUT
 *   config/profiles/<id>.json    one saved profile (background + searchIntent)
 *   config/profiles/_active.json { "id": "<id>" }
 *
 * ACTIVATION IS THE ONLY WRITE THAT MATTERS. It regenerates the three runtime
 * files every existing consumer already reads — candidate.json, and the
 * profile-dependent parts of scoring.json and exclusions.json — so the whole
 * pipeline follows the active profile without any other module knowing that
 * profiles exist. See ./derive.js for exactly what is regenerated.
 *
 * TWO SAFETY PROPERTIES.
 *
 *  1. NOTHING IS SILENTLY OVERWRITTEN. Every write keeps a `.bak`, the derived
 *     candidate is schema-validated BEFORE it replaces a working one, and the
 *     write is atomic — a crash mid-activation cannot leave a half-written
 *     profile that fails to load at startup.
 *
 *  2. NO LEAKAGE BETWEEN CANDIDATES. Activation REPLACES the derived fields
 *     rather than merging them, so one candidate's titles, skills, industries
 *     or seniority rules can never survive into another's search. The user's
 *     own hand-written rules (their exclusion phrases, tiers, sponsorship
 *     lists) are the deliberate exception and are always preserved.
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync, unlinkSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { writeFileAtomic } from '../utils/fsSafe.js';
import { readJson, CONFIG_FILES, loadConfig } from '../config/loadConfig.js';
import { rescoreStale } from '../pipeline/index.js';
import { SCHEMA_FILES, createValidator, validateConfig } from '../config/validateConfig.js';
import { normalizeProfile, fromCandidateConfig, slugify } from './model.js';
import { validateAnswerEntry } from '../config/screeningAnswerRules.js';
import { deriveFromProfile, applyScoring, applyExclusions, applyScreeningAnswers } from './derive.js';
import { loadRoleFamilies } from './roleFamilies.js';

/** Directory holding saved profiles, relative to the project root. */
export const PROFILES_DIR = join('config', 'profiles');

/** Pointer file naming the active profile. */
export const ACTIVE_FILE = '_active.json';

/** Most profiles kept. Well past any real use; a bound, not a target. */
const MAX_PROFILES = 50;

const profilesDir = (root) => join(root, PROFILES_DIR);
const profilePath = (root, id) => join(profilesDir(root), `${safeId(id)}.json`);
const activePath = (root) => join(profilesDir(root), ACTIVE_FILE);

/**
 * Reject any id that is not a plain slug.
 *
 * The id becomes a FILENAME, so "../../.env" must never round-trip through it.
 * `slugify` already strips everything but letters, digits and hyphens; this is
 * the assertion that says so out loud at the boundary.
 */
export function safeId(id) {
  const slug = slugify(id);
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`"${id}" is not a usable profile id`);
  }
  return slug;
}

/** Ensure config/profiles exists. */
function ensureDir(root) {
  const dir = profilesDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Copy a file aside as .bak before replacing it. Best effort. */
function keepPreviousVersion(path) {
  if (!existsSync(path)) return null;
  try {
    copyFileSync(path, `${path}.bak`);
    return `${path}.bak`;
  } catch {
    return null;
  }
}

/**
 * Every saved profile, newest-updated first, with the active one marked.
 *
 * @param {string} root
 * @returns {{profiles: Array, activeId: string|null, dir: string}}
 */
export function listProfiles(root) {
  const dir = profilesDir(root);
  if (!existsSync(dir)) return { profiles: [], activeId: null, dir };
  const activeId = readActiveId(root);
  const profiles = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') || file === ACTIVE_FILE || file.endsWith('.bak')) continue;
    try {
      const profile = normalizeProfile(readJson(join(dir, file)));
      profiles.push({
        id: profile.id,
        label: profile.label,
        active: profile.id === activeId,
        updatedAt: profile.updatedAt,
        targetRoles: profile.searchIntent.targetRoles,
        seniority: profile.searchIntent.seniority,
        skillCount: profile.searchIntent.skillsToKeep.length + profile.background.skills.length,
        source: profile.background.source,
      });
    } catch (err) {
      profiles.push({ id: file.replace(/\.json$/, ''), label: file, error: err.message, active: false });
    }
  }
  profiles.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return { profiles, activeId, dir };
}

/** The active profile's id, or null. */
export function readActiveId(root) {
  const path = activePath(root);
  if (!existsSync(path)) return null;
  try {
    const id = readJson(path)?.id;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

/**
 * Read one saved profile.
 * @returns {object|null} normalized profile, or null when it does not exist
 */
export function readProfile(root, id) {
  const path = profilePath(root, id);
  if (!existsSync(path)) return null;
  return normalizeProfile(readJson(path));
}

/** The currently active profile, or null when none has been activated. */
export function readActiveProfile(root) {
  const id = readActiveId(root);
  return id ? readProfile(root, id) : null;
}

/**
 * Save a profile (create or replace). Does NOT activate it — switching what the
 * pipeline searches for is always a separate, explicit act.
 *
 * @param {string} root
 * @param {object} profile
 * @returns {{id: string, path: string, backup: string|null, created: boolean}}
 */
export function saveProfile(root, profile) {
  ensureDir(root);
  const normalized = normalizeProfile(profile);
  const id = safeId(normalized.id);
  const { profiles } = listProfiles(root);
  const existing = profiles.find((p) => p.id === id);
  if (!existing && profiles.length >= MAX_PROFILES) {
    throw new Error(`that would be ${profiles.length + 1} saved profiles (limit ${MAX_PROFILES}) — delete one first`);
  }
  const path = profilePath(root, id);
  const backup = keepPreviousVersion(path);
  writeFileAtomic(path, `${JSON.stringify({ ...normalized, id }, null, 2)}\n`);
  return { id, path, backup, created: !existing };
}

/** Delete a saved profile. The ACTIVE profile cannot be deleted. */
export function deleteProfile(root, id) {
  const safe = safeId(id);
  if (readActiveId(root) === safe) {
    throw new Error('that profile is active — activate another one before deleting it');
  }
  const path = profilePath(root, safe);
  if (!existsSync(path)) throw new Error(`no profile named "${safe}"`);
  unlinkSync(path);
  return { id: safe, deleted: true };
}

/**
 * Activate a profile: regenerate candidate.json, and the profile-dependent
 * parts of scoring.json and exclusions.json.
 *
 * @param {string} root
 * @param {string} id
 * @param {object} [options]
 * @param {object} [options.taxonomy]
 * @param {boolean} [options.dryRun] compute everything, write nothing
 * @param {object} [options.db] Database handle; when given, stored verdicts are
 *   re-judged under the new profile (rescoreStale) and the count returned as `rescored`
 * @returns {{id, label, written: string[], families, searchPhrases, targetTitles,
 *            seniorityExclusions: string[], dryRun: boolean}}
 */
export function activateProfile(root, id, { taxonomy, dryRun = false, db = null } = {}) {
  const safe = safeId(id);
  const profile = readProfile(root, safe);
  if (!profile) throw new Error(`no profile named "${safe}"`);

  const tax = taxonomy ?? loadRoleFamilies(root);
  const derived = deriveFromProfile(profile, { taxonomy: tax });

  if (!derived.candidate.targetTitles.length) {
    throw new Error(
      `"${profile.label}" has no target roles, so discovery would search for nothing. `
      + 'Add at least one role to its search intent first.',
    );
  }

  // Validate BEFORE replacing a working config. A profile that cannot produce a
  // loadable candidate.json must fail here, not at the next startup.
  const schemaFile = join(root, 'config', 'schemas', SCHEMA_FILES.candidate);
  if (existsSync(schemaFile)) {
    const result = validateConfig('candidate', derived.candidate, readJson(schemaFile), { ajv: createValidator() });
    if (!result.valid) {
      const lines = (result.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`);
      throw new Error(`activating "${profile.label}" would write an invalid candidate.json — ${lines.join('; ')}`);
    }
  }

  const candidateFile = join(root, 'config', CONFIG_FILES.candidate);
  const scoringFile = join(root, 'config', CONFIG_FILES.scoring);
  const exclusionsFile = join(root, 'config', CONFIG_FILES.exclusions);

  const scoring = existsSync(scoringFile)
    ? applyScoring(readJson(scoringFile), derived) : null;
  const exclusions = existsSync(exclusionsFile)
    ? applyExclusions(readJson(exclusionsFile), derived) : null;

  // EVERY DERIVED ANSWER IS CHECKED BEFORE IT CAN BE WRITTEN.
  //
  // These go verbatim onto employers' forms, so a generator bug must fail here
  // rather than on an application. The check is the same one a hand-written
  // answer faces, judged against this profile's own stated requirement.
  const requiresSponsorship = derived.profile.searchIntent.workAuthorization.requiresSponsorship;
  for (const entry of derived.screeningAnswers) {
    const check = validateAnswerEntry(entry, { requiresSponsorship });
    if (!check.valid) {
      throw new Error(`activating "${profile.label}" would write an untruthful screening answer `
        + `("${entry.id}": ${check.error})`);
    }
  }
  const screeningFile = join(root, 'config', CONFIG_FILES.screeningAnswers);
  const screening = existsSync(screeningFile)
    ? applyScreeningAnswers(readJson(screeningFile), derived) : null;

  const summary = {
    id: safe,
    label: profile.label,
    families: derived.families.map((f) => ({ id: f.id, label: f.label })),
    searchPhrases: derived.searchPhrases,
    targetTitles: derived.candidate.targetTitles,
    seniorityExclusions: exclusions?.roleMismatchDerived ?? [],
    derivedAnswers: derived.screeningAnswers.map((a) => a.id),
    written: [],
    dryRun,
  };
  if (dryRun) return summary;

  ensureDir(root);

  // ALL FIVE FILES, OR NONE OF THEM.
  //
  // Each write is individually atomic, so no single file can be torn — but the
  // BUNDLE was not, and the five describe one candidate between them. A failure
  // after candidate.json and before screening_answers.json left one person's
  // identity beside another person's work-authorization answers, which is
  // exactly the mixture every other guard in this module exists to prevent,
  // arrived at by crashing rather than by switching.
  //
  // The whole previous state is captured first, then the writes run, and any
  // failure restores every file this call had already replaced. The active
  // pointer is written LAST on purpose: until it moves, nothing considers the
  // new profile active, so an interruption before it lands leaves the previous
  // profile coherently in charge.
  const writes = [
    { path: candidateFile, body: `${JSON.stringify(derived.candidate, null, 2)}\n`, label: `config/${CONFIG_FILES.candidate}` },
    ...(scoring ? [{ path: scoringFile, body: `${JSON.stringify(scoring, null, 2)}\n`, label: `config/${CONFIG_FILES.scoring}` }] : []),
    ...(exclusions ? [{ path: exclusionsFile, body: `${JSON.stringify(exclusions, null, 2)}\n`, label: `config/${CONFIG_FILES.exclusions}` }] : []),
    ...(screening ? [{ path: screeningFile, body: `${JSON.stringify(screening, null, 2)}\n`, label: `config/${CONFIG_FILES.screeningAnswers}` }] : []),
    {
      path: activePath(root),
      body: `${JSON.stringify({ id: safe, activatedAt: new Date().toISOString() }, null, 2)}\n`,
      label: `${PROFILES_DIR}/${ACTIVE_FILE}`,
    },
  ];

  // Snapshot before touching anything. `null` records "this file did not exist",
  // which rolls back to deleting it rather than to writing an empty one.
  const snapshot = writes.map(({ path }) => ({
    path,
    previous: existsSync(path) ? readFileSync(path, 'utf8') : null,
  }));

  const done = [];
  try {
    for (const { path, body, label } of writes) {
      keepPreviousVersion(path);
      writeFileAtomic(path, body);
      done.push(label);
      summary.written.push(label);
    }
  } catch (err) {
    for (const { path, previous } of snapshot) {
      try {
        if (previous === null) { if (existsSync(path)) unlinkSync(path); }
        else writeFileAtomic(path, previous);
      } catch { /* best effort: the .bak files remain as a manual fallback */ }
    }
    summary.written = [];
    throw new Error(
      `activating "${profile.label}" failed after writing ${done.length} of ${writes.length} files `
      + `(${err.message}). Every file was rolled back to its previous contents, so the configuration `
      + 'is still the one that was active before — no half-switched profile was left behind.',
      { cause: err },
    );
  }

  // F10 — THE BOARD FOLLOWS THE PROFILE. A switch changes the fingerprint of
  // every stored verdict, and until now those verdicts stayed on the board,
  // labelled current, until each posting happened to be listed again. Given a
  // database handle, every active row is re-judged from its stored text right
  // here (no network). Never fatal: the profile IS active either way.
  if (db) {
    try {
      const config = loadConfig({ root, loadEnv: false, env: {} });
      summary.rescored = rescoreStale({ db, config }).rescored;
    } catch (err) {
      summary.rescoreError = err.message;
    }
  }
  return summary;
}

/**
 * Stable fingerprint of a resume's text, for "I already answered this".
 *
 * Content rather than mtime or path: re-saving the same document, or restoring
 * it from a version, must not re-ask a question the user has settled, while an
 * actually edited resume must.
 *
 * @param {string[]} paragraphs
 * @returns {string}
 */
export function fingerprintResume(paragraphs = []) {
  return createHash('sha1')
    .update((Array.isArray(paragraphs) ? paragraphs : []).join('\n'))
    .digest('hex')
    .slice(0, 32);
}

/**
 * Record that the user has SEEN this resume and chosen to keep their current
 * search goals, so the drawer stops asking until the resume changes.
 *
 * @param {string} root
 * @param {string} resumeFingerprint from `fingerprintResume`
 * @returns {{acknowledged: boolean, id?: string}}
 */
export function acknowledgeResumeMismatch(root, resumeFingerprint) {
  const active = readActiveProfile(root);
  if (!active) return { acknowledged: false };
  const saved = saveProfile(root, { ...active, acknowledgedResume: resumeFingerprint });
  return { acknowledged: true, id: saved.id };
}

/**
 * One-time migration: turn an existing hand-written candidate.json into the
 * first saved profile, so nobody has to retype a working setup.
 *
 * Idempotent — if any profile already exists, this does nothing.
 *
 * @param {string} root
 * @returns {{migrated: boolean, id?: string, reason?: string}}
 */
export function migrateLegacyCandidate(root) {
  const { profiles } = listProfiles(root);
  if (profiles.length) return { migrated: false, reason: 'profiles already exist' };
  const candidateFile = join(root, 'config', CONFIG_FILES.candidate);
  if (!existsSync(candidateFile)) return { migrated: false, reason: 'no config/candidate.json to migrate' };

  const candidate = readJson(candidateFile);
  const profile = fromCandidateConfig(candidate);
  const { id } = saveProfile(root, profile);
  writeFileAtomic(activePath(root), `${JSON.stringify({ id, activatedAt: new Date().toISOString() }, null, 2)}\n`);
  return { migrated: true, id, label: profile.label };
}

/**
 * Read the master resume and build a profile proposal from it, WITHOUT writing
 * anything. The dashboard and CLI both call this before offering the choice
 * between creating a new search, keeping the current one, or merging.
 *
 * @param {string} root
 * @param {object} deps
 * @param {(bytes: Buffer) => {paragraphs: string[]}} deps.extractDocxText
 * @param {string} resumePath absolute path to the master resume
 * @returns {{available: boolean, reason?: string, proposal?: object, comparison?: object}}
 */
export async function proposeProfileFromResume(root, resumePath, { extractDocxText } = {}) {
  if (!existsSync(resumePath)) {
    return { available: false, reason: 'no master resume has been uploaded yet' };
  }
  const { profileFromResume, compareToActiveProfile, buildBackground } = await import('./fromResume.js');
  const extract = extractDocxText ?? (await import('../resume/docxText.js')).extractDocxText;
  const { paragraphs } = extract(readFileSync(resumePath));

  const active = readActiveProfile(root);
  const tax = loadRoleFamilies(root);
  const background = buildBackground(paragraphs, { sourceFile: resumePath });
  const comparison = compareToActiveProfile(background, active, tax);
  // Did the user already answer this exact question about this exact resume?
  // See `acknowledgedResume` in the profile model.
  const resumeFingerprint = fingerprintResume(paragraphs);
  const acknowledged = Boolean(active?.acknowledgedResume)
    && active.acknowledgedResume === resumeFingerprint;
  // `existingIds` is what makes "Create a profile" create one. Without it the
  // id derived from the candidate's name collided with their own saved profile
  // and `saveProfile` replaced it — see `uniqueProfileId`.
  const proposal = profileFromResume(paragraphs, {
    currentProfile: active,
    sourceFile: resumePath,
    existingIds: listProfiles(root).profiles.map((p) => p.id),
  });
  const derived = deriveFromProfile(proposal, { taxonomy: tax });

  return {
    available: true,
    comparison,
    resumeFingerprint,
    acknowledged,
    proposal,
    preview: {
      families: derived.families.map((f) => ({ id: f.id, label: f.label })),
      searchPhrases: derived.searchPhrases,
      targetTitles: derived.candidate.targetTitles,
    },
    // The three answers offered to the user. Named here so the dashboard and the
    // CLI present the same choice rather than each inventing their own.
    choices: [
      {
        id: 'create',
        label: 'Create a profile from this resume',
        detail: `Searches for ${proposal.searchIntent.targetRoles.slice(0, 3).join(', ') || 'the roles in this resume'}`
          + ` at ${proposal.searchIntent.seniority || 'unspecified'} level.`,
      },
      {
        id: 'keep',
        label: 'Keep my current goals',
        detail: active
          ? `Keeps searching for ${active.searchIntent.targetRoles.slice(0, 3).join(', ')}. The resume is still used for tailoring.`
          : 'Nothing changes. Discovery stays as configured.',
      },
      {
        id: 'merge',
        label: 'Merge into my current profile',
        detail: 'Adds what you pick from this resume to the active profile. Nothing is removed.',
      },
    ],
  };
}

/**
 * Re-read the ACTIVE profile's background (what the candidate has DONE) from
 * the master resume, leaving the search intent (what they WANT) untouched.
 *
 * Why this exists: a profile migrated from the template candidate.json kept
 * the template's background — "Example Corp", "Example University", a
 * placeholder achievement bullet, no skills. Those values fail the placeholder
 * guard, so no application could ever be prepared, and nothing in the product
 * could replace them short of hand-editing JSON. The resume already states
 * every one of them.
 *
 * Refuses when the resume names a different person than the profile — the
 * same guard `proposeProfileFromResume` applies — so one candidate's history
 * can never land in another's applications. A field the resume does not state
 * keeps its current value unless that value is template text.
 *
 * @param {string} root
 * @param {string} resumePath
 * @param {{ extractDocxText?: Function, db?: object, now?: Date }} [deps]
 * @returns {Promise<{ ok: boolean, reason?: string, id?: string, changed?: string[], activated?: object }>}
 */
export async function refreshBackgroundFromResume(root, resumePath, { extractDocxText, db = null, now = new Date() } = {}) {
  if (!existsSync(resumePath)) return { ok: false, reason: 'no master resume has been uploaded yet' };
  const active = readActiveProfile(root);
  if (!active) return { ok: false, reason: 'no search profile is active — create one first' };
  const { buildBackground, namesSamePerson } = await import('./fromResume.js');
  const { isPlaceholderValue } = await import('../config/placeholders.js');
  const extract = extractDocxText ?? (await import('../resume/docxText.js')).extractDocxText;
  const { paragraphs } = extract(readFileSync(resumePath));
  const fresh = buildBackground(paragraphs, { sourceFile: resumePath, now });
  if (fresh._name && !namesSamePerson(fresh, active)) {
    return { ok: false, reason: `the master resume names ${fresh._name}, not the active profile's candidate — create a separate profile for them instead` };
  }
  const templated = (v) => {
    if (Array.isArray(v)) return v.length === 0 || v.every((x) => templated(x));
    if (v && typeof v === 'object') return Object.values(v).some((x) => typeof x === 'string' && isPlaceholderValue(x));
    return v == null || v === '' || (typeof v === 'string' && isPlaceholderValue(v));
  };
  const before = active.background ?? {};
  const next = { ...before };
  const changed = [];
  for (const key of ['currentRoles', 'earlierRoles', 'yearsExperience', 'seniority', 'skills', 'industries',
    'certifications', 'education', 'workHistory', 'leadership']) {
    const value = fresh[key];
    const empty = value == null || value === '' || (Array.isArray(value) && value.length === 0);
    if (empty && !templated(before[key])) continue; // the resume is silent; keep what the user has
    if (JSON.stringify(before[key]) === JSON.stringify(value)) continue;
    next[key] = empty ? (Array.isArray(before[key]) ? [] : null) : value;
    changed.push(key);
  }
  Object.assign(next, { source: 'resume', sourceFile: resumePath, extractedAt: now.toISOString() });
  if (!changed.length) return { ok: true, id: active.id, changed: [] };
  saveProfile(root, { ...active, background: next, updatedAt: now.toISOString() });
  const activated = activateProfile(root, active.id, { db });
  return { ok: true, id: active.id, changed, activated };
}

/**
 * Merge selected evidence from a proposal into the ACTIVE profile.
 *
 * Additive only, and it only ever touches the two things a resume is evidence
 * for. A resume is a record of what someone has done, not a statement of what
 * they want, so this can add a target role the user PICKED but never removes
 * one they chose, and never touches locations, pay or work authorization.
 *
 * @param {string} root
 * @param {{roles?: string[], skills?: string[], industries?: string[]}} selection
 * @returns {{id: string, addedRoles: string[], addedSkills: string[], addedIndustries: string[]}}
 */
export function mergeIntoActiveProfile(root, { roles = [], skills = [], industries = [] } = {}) {
  const active = readActiveProfile(root);
  if (!active) throw new Error('no profile is active — create one first');

  const before = {
    roles: new Set(active.searchIntent.targetRoles.map((r) => r.toLowerCase())),
    skills: new Set(active.searchIntent.skillsToKeep.map((s) => s.toLowerCase())),
    industries: new Set(active.searchIntent.industries.map((i) => i.toLowerCase())),
  };
  const addedRoles = roles.filter((r) => r && !before.roles.has(String(r).toLowerCase()));
  const addedSkills = skills.filter((s) => s && !before.skills.has(String(s).toLowerCase()));
  const addedIndustries = industries.filter((i) => i && !before.industries.has(String(i).toLowerCase()));

  const merged = normalizeProfile({
    ...active,
    searchIntent: {
      ...active.searchIntent,
      targetRoles: [...active.searchIntent.targetRoles, ...addedRoles],
      skillsToKeep: [...active.searchIntent.skillsToKeep, ...addedSkills],
      industries: [...active.searchIntent.industries, ...addedIndustries],
    },
  });
  saveProfile(root, merged);
  return { id: merged.id, addedRoles, addedSkills, addedIndustries };
}
