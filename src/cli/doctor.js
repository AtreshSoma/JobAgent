/**
 * Doctor / preflight checks.
 *
 * Validates everything the pipeline depends on BEFORE a run, so failures
 * surface as one readable checklist instead of a mid-run crash:
 *
 *   - Node.js version (>= 22.5, required for the node:sqlite built-in)
 *   - SQLite access (in-memory smoke test + the real data/applied_jobs.db)
 *   - configuration files load and validate against their JSON schemas
 *   - candidate profile completeness (required fields hard-fail; truthful
 *     optional gaps like street address / GitHub URL are warnings — they are
 *     NEVER auto-filled or fabricated)
 *   - master resume present and readable (it is read-only source material)
 *   - Python + python-docx (resume tailoring; degrades to master-resume
 *     fallback when missing, so this is a warning, not a failure)
 *   - Playwright Chromium (browser assist; discovery/scoring work without it)
 *   - output directories writable (data, logs, reports, outputs)
 *   - test fixtures present (offline test suite stays runnable)
 *
 * Severity model:
 *   fail — the pipeline cannot run safely or correctly; exit code 1.
 *   warn — a non-critical capability is degraded; the run continues.
 *   pass — all good.
 *
 * Read-only by design except for the writability probes, which create and
 * delete a single temp file inside each output directory.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  existsSync, statSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';

import { loadConfig, PROJECT_ROOT } from '../config/loadConfig.js';
import { ui } from './ui.js';
import { findPlaceholders } from '../config/placeholders.js';
import { pythonCandidates, checkPythonVersion, MIN_PYTHON } from '../resume/pythonEnv.js';

export const SEVERITY = Object.freeze({ PASS: 'pass', WARN: 'warn', FAIL: 'fail' });

/** Minimum supported Node.js major version (node:sqlite landed in 22.5). */
export const MIN_NODE_MAJOR = 22;

/** Output directories that must exist and be writable. */
export const OUTPUT_DIRS = ['data', 'logs', 'reports', 'applications/output', 'resumes/output'];

/** Fixtures the offline test suite cannot run without. */
export const REQUIRED_FIXTURES = [
  'tests/node/fixtures/jobs.js',
  'tests/node/fixtures/apply_form.html',
  'tests/node/fixtures/embed_host.html',
  'tests/node/fixtures/grnhse_embed_form.html',
  'tests/node/fixtures/careers_page.html',
  'tests/node/fixtures/captcha_page.html',
  'tests/node/fixtures/sample_resume.txt',
];

/**
 * Candidate profile fields the pipeline cannot run without.
 * `path` is dot-notation into config/candidate.json.
 */
export const REQUIRED_PROFILE_FIELDS = [
  { path: 'identity.fullName', label: 'full name' },
  { path: 'contact.email', label: 'email' },
  { path: 'contact.phone', label: 'phone' },
  { path: 'location.city', label: 'city' },
  { path: 'location.state', label: 'state' },
  { path: 'location.zip', label: 'ZIP code' },
  { path: 'location.country', label: 'country' },
  { path: 'workAuthorization.status', label: 'work authorization status' },
  { path: 'workAuthorization.requiresSponsorship', label: 'sponsorship requirement' },
  { path: 'targetTitles', label: 'target titles' },
];

/**
 * Truthful-but-optional fields: useful for ATS prefill, but the system must
 * never invent them. Empty values are reported as gaps for the USER to fill.
 */
export const OPTIONAL_PROFILE_FIELDS = [
  { path: 'location.street', label: 'street address (some ATS forms require it)' },
  { path: 'identity.links.linkedin', label: 'LinkedIn URL' },
  { path: 'identity.links.github', label: 'GitHub URL' },
  { path: 'identity.links.portfolio', label: 'portfolio URL' },
];

/** Read a dot-notation path off an object. */
function dig(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** True when a profile value is meaningfully present. */
function present(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true; // booleans and numbers (including false/0) are explicit answers
}

/**
 * Missing REQUIRED candidate fields.
 * @param {object} candidate config/candidate.json contents
 * @returns {Array<{path: string, label: string}>}
 */
export function requiredProfileGaps(candidate = {}) {
  return REQUIRED_PROFILE_FIELDS.filter((f) => !present(dig(candidate, f.path)));
}

/**
 * Empty OPTIONAL candidate fields (truthful gaps; never auto-filled).
 * @param {object} candidate
 * @returns {Array<{path: string, label: string}>}
 */
export function optionalProfileGaps(candidate = {}) {
  return OPTIONAL_PROFILE_FIELDS.filter((f) => !present(dig(candidate, f.path)));
}

/**
 * Interpreters to probe, in the SAME order the tailor resolves them
 * (src/resume/pythonEnv.js). Doctor used to probe `python` then `python3`
 * while the tailor ran `python`, so it could pass on an interpreter the tailor
 * never used and ignore the project `.venv` that actually had python-docx.
 */
function doctorPythonCandidates(env = {}, root) {
  return pythonCandidates(env, { root });
}

/** Run a command synchronously; returns { ok, stdout, stderr } and never throws. */
function tryRun(spawnImpl, cmd, args) {
  try {
    const r = spawnImpl(cmd, args, { encoding: 'utf8', timeout: 15000 });
    return {
      ok: r.status === 0 && !r.error,
      stdout: (r.stdout ?? '').trim(),
      stderr: (r.stderr ?? '').trim(),
    };
  } catch (err) {
    return { ok: false, stdout: '', stderr: err.message };
  }
}

/**
 * Checks about the ACTIVE SEARCH PROFILE.
 *
 * Three questions, in the order they can hurt:
 *   1. Is a profile active at all, or is the pipeline running on a
 *      hand-written candidate.json nobody has reviewed?
 *   2. Has the generated config DRIFTED from the profile — i.e. did someone
 *      hand-edit candidate.json after activating, so the next activation will
 *      silently discard their edit?
 *   3. Does the profile actually produce a usable search?
 *
 * @param {string} root
 * @param {object} config loaded bundle
 * @returns {Array<object>} checks
 */
export function profileChecks(root, config) {
  const checks = [];
  const profile = config.profile ?? null;
  const generatedFrom = config.candidate?._generatedFrom ?? null;

  if (!profile) {
    checks.push(makeCheck('profile-active', 'Active search profile', SEVERITY.WARN,
      'no search profile is active — discovery is running on config/candidate.json exactly as written',
      'Run `npm run profiles migrate` to import it as a profile. You then get switching, '
      + 'role-family title expansion, and profile-derived scoring, and `npm run profiles show` '
      + 'will tell you exactly what the agent is searching for.'));
    return checks;
  }

  const roles = profile.searchIntent?.targetRoles ?? [];
  const phrases = config.candidate?.searchPhrases ?? [];
  checks.push(makeCheck('profile-active', 'Active search profile', SEVERITY.PASS,
    `"${profile.label}" — targeting ${roles.slice(0, 3).join(', ')}`
    + `${roles.length > 3 ? ` +${roles.length - 3} more` : ''}`
    + `${phrases.length ? `; boards searched for ${phrases.map((p) => `"${p}"`).join(', ')}` : ''}`));

  // DRIFT. candidate.json is a GENERATED view of the profile. A hand edit to it
  // survives until the next activation and then vanishes without warning, which
  // is exactly the kind of silent loss this tool must not have.
  if (generatedFrom) {
    const configured = (config.candidate?.targetTitles ?? []).map((t) => String(t).toLowerCase());
    const missing = roles.filter((r) => !configured.includes(String(r).toLowerCase()));
    checks.push(missing.length === 0
      ? makeCheck('profile-sync', 'Profile and generated config agree', SEVERITY.PASS,
        `config/candidate.json was generated from ${generatedFrom}`)
      : makeCheck('profile-sync', 'Profile and generated config agree', SEVERITY.WARN,
        `config/candidate.json no longer contains ${missing.length} of the profile's target role(s): ${missing.join(', ')}`,
        'config/candidate.json is GENERATED from the profile. Edit the profile and re-run '
        + '`npm run profiles activate <id>`, or your next activation will overwrite the change.'));
  }

  if (!roles.length) {
    checks.push(makeCheck('profile-targets', 'Search profile targets a role', SEVERITY.FAIL,
      'the active profile names no target roles, so discovery would search for nothing',
      'Add at least one role to the profile searchIntent.targetRoles, then re-activate it.'));
  }

  // A profile with no skills scores 0 on the 30-point coreSkills category, so
  // every posting looks mediocre and nothing clears the Apply bar. Worth saying
  // plainly rather than letting the board look empty for no visible reason.
  const skillCount = (profile.searchIntent?.skillsToKeep ?? []).length
    + (profile.background?.skills ?? []).length;
  if (skillCount < 5) {
    checks.push(makeCheck('profile-skills', 'Search profile has enough skills to score with', SEVERITY.WARN,
      `only ${skillCount} skill term(s) — coreSkills is 30 of 100 points and would score near zero`,
      'Add the tools, methods, systems and credentials your field actually uses to the profile. '
      + 'They do not have to be software. `npm run profiles from-resume` can read them off your resume.'));
  }
  return checks;
}

function makeCheck(id, label, severity, detail, fix = null) {
  return { id, label, status: severity, detail, ...(fix ? { fix } : {}) };
}

/**
 * Run every preflight check. Pure data out — printing is separate.
 *
 * @param {object} [options]
 * @param {string} [options.root=PROJECT_ROOT]
 * @param {NodeJS.ProcessEnv} [options.env=process.env]
 * @param {object} [options.deps]
 * @param {Function} [options.deps.spawnImpl] spawnSync override (testing)
 * @param {Function} [options.deps.loadConfigImpl] loadConfig override (testing)
 * @param {string} [options.deps.nodeVersion] process.version override (testing)
 * @returns {Promise<{ checks: object[], summary: {pass:number,warn:number,fail:number}, ok: boolean }>}
 */
export async function runDoctor({ root = PROJECT_ROOT, env = process.env, deps = {} } = {}) {
  const spawnImpl = deps.spawnImpl ?? spawnSync;
  const loadConfigImpl = deps.loadConfigImpl ?? loadConfig;
  const checks = [];

  /* ── Node.js version ─────────────────────────────────────────────────── */
  const nodeVersion = deps.nodeVersion ?? process.version;
  const major = Number(String(nodeVersion).replace(/^v/, '').split('.')[0]);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
    checks.push(makeCheck('node', 'Node.js version', SEVERITY.PASS, `${nodeVersion} (>= ${MIN_NODE_MAJOR} required)`));
  } else {
    checks.push(makeCheck('node', 'Node.js version', SEVERITY.FAIL,
      `${nodeVersion} is below the required Node ${MIN_NODE_MAJOR}`,
      `Install Node ${MIN_NODE_MAJOR}+ (node:sqlite requires Node 22.5 or newer).`));
  }

  /* ── SQLite (built-in module + real database file) ───────────────────── */
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const mem = new DatabaseSync(':memory:');
    mem.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1);');
    const row = mem.prepare('SELECT COUNT(*) AS c FROM t').get();
    mem.close();
    if (row?.c !== 1) throw new Error('smoke write/read returned unexpected result');
    checks.push(makeCheck('sqlite', 'SQLite (node:sqlite)', SEVERITY.PASS, 'in-memory write/read OK'));
  } catch (err) {
    checks.push(makeCheck('sqlite', 'SQLite (node:sqlite)', SEVERITY.FAIL, err.message,
      'node:sqlite is unavailable — check your Node installation/version.'));
  }

  try {
    // Open the real DB the same way the pipeline does (creates data/ if needed).
    const { openDatabase } = await import('../logging/db.js');
    const db = openDatabase({ path: join(root, 'data', 'applied_jobs.db') });
    try {
      const n = db.listJobs({}).length;
      checks.push(makeCheck('db', 'Job database', SEVERITY.PASS, `data/applied_jobs.db opens (${n} job(s) tracked)`));
    } finally {
      db.close();
    }
  } catch (err) {
    checks.push(makeCheck('db', 'Job database', SEVERITY.FAIL, err.message,
      'data/applied_jobs.db could not be opened — check file permissions under data/.'));
  }

  /* ── Configuration + candidate profile ───────────────────────────────── */
  let config = null;
  try {
    config = loadConfigImpl({ root, loadEnv: false, env });
    checks.push(makeCheck('config', 'Configuration', SEVERITY.PASS,
      'all config files load and validate against their schemas'));
  } catch (err) {
    // candidate.json / screening_answers.json are gitignored (personal data),
    // so a fresh clone will not have them — point straight at the templates.
    const hint = /candidate\.json|screening_answers\.json/.test(err.message)
      ? 'These files hold YOUR personal data and are not tracked in git. Copy '
        + 'config/candidate.example.json -> config/candidate.json and '
        + 'config/screening_answers.example.json -> config/screening_answers.json, then fill them in.'
      : 'Fix the listed config issue(s) under config/ — config is the source of truth for personal data.';
    checks.push(makeCheck('config', 'Configuration', SEVERITY.FAIL, err.message, hint));
  }

  if (config) {
    const required = requiredProfileGaps(config.candidate);
    if (required.length === 0) {
      checks.push(makeCheck('profile', 'Candidate profile (required fields)', SEVERITY.PASS,
        'all required fields present'));
    } else {
      checks.push(makeCheck('profile', 'Candidate profile (required fields)', SEVERITY.FAIL,
        `missing: ${required.map((g) => `${g.label} (${g.path})`).join(', ')}`,
        'Add the missing value(s) to config/candidate.json. Never guess — only enter true information.'));
    }

    // Presence is not plausibility. Every required field can be filled and every
    // value can still be the template text shipped in the .example files — which
    // is exactly what a new user gets by following the documented first step.
    // This check is a FAIL, not a warning: these strings are typed verbatim into
    // an employer's work-authorization and sponsorship fields.
    const templated = findPlaceholders(config);
    if (templated.ok) {
      checks.push(makeCheck('profile-placeholders', 'Candidate profile (real values, not template text)',
        SEVERITY.PASS, 'no placeholder values found'));
    } else {
      checks.push(makeCheck('profile-placeholders', 'Candidate profile (real values, not template text)',
        SEVERITY.FAIL,
        `${templated.placeholders.length} field(s) still hold example text: `
        + templated.placeholders.map((p) => `${p.label} = "${p.value}"`).join('; '),
        'Replace these with your own truthful values in config/candidate.json and '
        + 'config/screening_answers.json. Until you do, the pipeline will not prepare '
        + 'or submit an application — these values go verbatim onto employers\' forms.'));
    }

    const optional = optionalProfileGaps(config.candidate);
    if (optional.length === 0) {
      checks.push(makeCheck('profile-optional', 'Candidate profile (optional fields)', SEVERITY.PASS,
        'no truthful gaps'));
    } else {
      checks.push(makeCheck('profile-optional', 'Candidate profile (optional fields)', SEVERITY.WARN,
        `empty: ${optional.map((g) => `${g.label} (${g.path})`).join(', ')}`,
        'These are left blank on forms (surfaced as blockers when an ATS requires them). Fill them in config/candidate.json only if real.'));
    }

    /* ── Active search profile ──────────────────────────────────────────
     *
     * WHOSE SEARCH IS THIS? The single most expensive silent failure in this
     * tool was a run that kept using one person's target titles after another
     * person's resume had been uploaded — nothing anywhere said so. These
     * checks make the answer visible before a run, not after it.
     */
    checks.push(...profileChecks(root, config));
  }

  /* ── Master resume (read-only source material) ───────────────────────── */
  const master = join(root, 'resumes', 'base', 'MASTER_RESUME.docx');
  if (existsSync(master) && statSync(master).size > 0) {
    checks.push(makeCheck('resume', 'Master resume', SEVERITY.PASS,
      `resumes/base/MASTER_RESUME.docx (${statSync(master).size} bytes; opened read-only, never modified)`));
  } else {
    checks.push(makeCheck('resume', 'Master resume', SEVERITY.FAIL,
      'resumes/base/MASTER_RESUME.docx is missing or empty',
      'Place your master resume at resumes/base/MASTER_RESUME.docx. It is the read-only source for tailoring.'));
  }

  /* ── Python toolchain (tailoring; degrades gracefully) ───────────────── */
  let pythonExe = null;
  let pythonDetail = '';
  for (const candidate of doctorPythonCandidates(env, root)) {
    const r = tryRun(spawnImpl, candidate, ['--version']);
    if (r.ok) {
      pythonExe = candidate;
      pythonDetail = r.stdout || r.stderr;
      break;
    }
  }
  const pyVersion = pythonExe ? checkPythonVersion(pythonDetail) : null;
  if (pythonExe && !pyVersion.ok) {
    checks.push(makeCheck('python', 'Python', SEVERITY.WARN,
      `${pythonExe} is ${pyVersion.version ? `Python ${pyVersion.version}` : `unrecognised (${pythonDetail})`}`
      + ` — this project needs ${MIN_PYTHON.join('.')}+; resume tailoring may fail and fall back to the master resume`,
      `Install Python ${MIN_PYTHON.join('.')}+ and create the project venv: python3 -m venv .venv && `
      + '.venv/bin/python -m pip install -r requirements.txt (or set PYTHON in .env).'));
  } else if (pythonExe) {
    checks.push(makeCheck('python', 'Python', SEVERITY.PASS, `${pythonExe} — ${pythonDetail}`));
    const docx = tryRun(spawnImpl, pythonExe, ['-c', 'import docx; print(docx.__version__ if hasattr(docx, "__version__") else "ok")']);
    if (docx.ok) {
      checks.push(makeCheck('python-docx', 'python-docx package', SEVERITY.PASS, `importable (${docx.stdout || 'ok'})`));
    } else {
      checks.push(makeCheck('python-docx', 'python-docx package', SEVERITY.WARN,
        'not importable — resume tailoring will fall back to the untailored master resume',
        `Run: ${pythonExe} -m pip install -r requirements.txt`));
    }
    // PDF export defaults to ON, and on a machine with neither Word nor
    // LibreOffice it can never succeed — which used to fail silently per job and
    // surface later as an unexplained dashboard preview error. Report the
    // capability here, once, up front. WARN not FAIL: the DOCX is the
    // deliverable and is always produced; only the preview degrades.
    const pdfProbe = tryRun(spawnImpl, pythonExe, ['-c',
      'import sys, json; sys.path.insert(0, "src/resume"); '
      + 'from pdfExport import converter_availability; print(json.dumps(converter_availability()))']);
    let pdfInfo = null;
    try { pdfInfo = JSON.parse(pdfProbe.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
    if (pdfInfo?.available) {
      const via = pdfInfo.word ? 'Microsoft Word (docx2pdf)' : `LibreOffice (${pdfInfo.libreoffice})`;
      checks.push(makeCheck('pdf-converter', 'DOCX to PDF converter', SEVERITY.PASS, `available via ${via}`));
    } else {
      checks.push(makeCheck('pdf-converter', 'DOCX to PDF converter', SEVERITY.WARN,
        `none available${pdfInfo?.word_reason ? ` — ${pdfInfo.word_reason}` : ''}`
        + ' — tailored resumes are still produced as DOCX; only the PDF preview is unavailable',
        'Install LibreOffice (works everywhere, including Linux/CI) or Microsoft Word, '
        + 'or set resumeExportPdf=false to stop attempting the conversion.'));
    }

    const pytest = tryRun(spawnImpl, pythonExe, ['-m', 'pytest', '--version']);
    checks.push(pytest.ok
      ? makeCheck('pytest', 'pytest', SEVERITY.PASS, pytest.stdout.split('\n')[0])
      : makeCheck('pytest', 'pytest', SEVERITY.WARN,
        'not installed — Python tests cannot run',
        `Run: ${pythonExe} -m pip install -r requirements.txt`));
  } else {
    checks.push(makeCheck('python', 'Python', SEVERITY.WARN,
      'no python/python3 on PATH — resume tailoring will fall back to the untailored master resume',
      `Install Python ${MIN_PYTHON.join('.')}+ and run: python3 -m pip install -r requirements.txt (or set PYTHON in .env).`));
  }

  /* ── Playwright browser (assist; discovery/scoring work without it) ─── */
  try {
    const { chromium } = await import('playwright');
    const exe = chromium.executablePath();
    if (exe && existsSync(exe)) {
      checks.push(makeCheck('browser', 'Playwright Chromium', SEVERITY.PASS, exe));
    } else {
      checks.push(makeCheck('browser', 'Playwright Chromium', SEVERITY.WARN,
        'Chromium is not downloaded — browser assist (form filling) is unavailable',
        'Run: npx playwright install chromium'));
    }
  } catch (err) {
    checks.push(makeCheck('browser', 'Playwright Chromium', SEVERITY.WARN,
      `playwright not importable (${err.message})`, 'Run: npm install'));
  }

  /* ── Output directories writable ─────────────────────────────────────── */
  const unwritable = [];
  for (const rel of OUTPUT_DIRS) {
    const dir = join(root, rel);
    try {
      mkdirSync(dir, { recursive: true });
      const probe = join(dir, `.doctor-probe-${randomUUID()}`);
      writeFileSync(probe, 'probe', 'utf8');
      rmSync(probe);
    } catch (err) {
      unwritable.push(`${rel} (${err.code ?? err.message})`);
    }
  }
  checks.push(unwritable.length === 0
    ? makeCheck('outputs', 'Output directories', SEVERITY.PASS, `${OUTPUT_DIRS.length} writable: ${OUTPUT_DIRS.join(', ')}`)
    : makeCheck('outputs', 'Output directories', SEVERITY.FAIL,
      `not writable: ${unwritable.join('; ')}`,
      'Fix permissions for the listed directories so the pipeline can write its artifacts.'));

  /* ── Test fixtures present ───────────────────────────────────────────── */
  const missingFixtures = REQUIRED_FIXTURES.filter((f) => !existsSync(join(root, f)));
  checks.push(missingFixtures.length === 0
    ? makeCheck('fixtures', 'Test fixtures', SEVERITY.PASS, `${REQUIRED_FIXTURES.length} present`)
    : makeCheck('fixtures', 'Test fixtures', SEVERITY.WARN,
      `missing: ${missingFixtures.join(', ')}`,
      'Restore the missing fixture files (the offline test suite depends on them).'));

  const summary = {
    pass: checks.filter((c) => c.status === SEVERITY.PASS).length,
    warn: checks.filter((c) => c.status === SEVERITY.WARN).length,
    fail: checks.filter((c) => c.status === SEVERITY.FAIL).length,
  };
  return { checks, summary, ok: summary.fail === 0 };
}

/** Render a doctor result to the console. */
export function printDoctorReport(result) {
  ui.heading('Doctor — preflight checks');
  ui.blank();
  for (const check of result.checks) {
    if (check.status === SEVERITY.PASS) ui.success(`${check.label} — ${check.detail}`);
    else if (check.status === SEVERITY.WARN) ui.warn(`${check.label} — ${check.detail}`);
    else ui.fail(`${check.label} — ${check.detail}`);
    if (check.fix && check.status !== SEVERITY.PASS) ui.note(`    fix: ${check.fix}`);
  }
  ui.blank();
  ui.stats([
    ['Passed', result.summary.pass, 'good'],
    ['Warnings', result.summary.warn, result.summary.warn ? 'warn' : 'muted'],
    ['Failures', result.summary.fail, result.summary.fail ? 'bad' : 'good'],
  ]);
  ui.blank();
  if (result.ok) {
    ui.success('Preflight passed — the pipeline is ready to run.');
    ui.next([{ text: 'Run the full pipeline:', cmd: 'npm start' }]);
  } else {
    ui.fail('Preflight failed — fix the failures above before running the pipeline.');
  }
}
