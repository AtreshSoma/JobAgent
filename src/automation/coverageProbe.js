/**
 * Auto-fill coverage probe (audit A1, A13).
 *
 * "Fixture-tested" says nothing about how much of a real form auto-fill can
 * answer. This opens ONE application page, runs the dry run that types and
 * clicks nothing (audit N2), and records what it found: for each field, whether
 * it would be filled, is already filled, or needs the person; how many upload
 * slots; and which control it would press next. Results are stored per ATS so
 * the dashboard can show a measured table.
 *
 * WHAT IT RECORDS: labels, kinds, required flags and statuses. Never a value:
 * nothing the candidate typed or would type is written down.
 *
 * WHAT IT MAY OPEN: saved pages and local or reserved test hosts only. A probe
 * of a real employer's site is a separate step that needs the owner's go-ahead,
 * so `probeForm` refuses any other URL before opening anything. The caller owns
 * the network (it routes a fixture to the page); this module only guards the
 * address it is asked to open.
 *
 * Page one only: a dry run stops before any click, so a multi-step form is
 * measured on its first page.
 */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectAts } from '../apply/atsDetector.js';
import { workspacePaths } from '../profile/workspace.js';
import { assistApply } from './applyRunner.js';
import { applicationFields, resolveFormScope, scanFields } from './domScanner.js';

const KEEP = 200;
const FILE = 'ats_coverage.json';

/**
 * Throw unless `url` is a saved page or a local or reserved test host.
 * @param {string} url
 */
export function assertProbeAllowed(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`refusing to probe "${url}": not a URL`); }
  const host = parsed.hostname.toLowerCase();
  const local = parsed.protocol === 'file:'
    || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)
    || host.endsWith('.localhost') || host.endsWith('.test') || host.endsWith('.example') || host.endsWith('.invalid');
  if (!local) {
    throw new Error(`refusing to probe ${host}: probes run only on saved pages and local or reserved test hosts. `
      + 'A probe of a real site needs the owner\'s go-ahead.');
  }
}

/**
 * Probe one application page.
 *
 * @param {object} args
 * @param {object} args.page Playwright page (the caller has routed the network)
 * @param {string} args.url the page to open (must pass assertProbeAllowed)
 * @param {object} args.config loadConfig bundle (candidate, screening answers)
 * @param {string} [args.ats] platform key; detected from the URL when omitted
 * @param {object} [args.deps] passed to assistApply
 * @returns {Promise<object>} a coverage record (see recordCoverage)
 */
export async function probeForm({ page, url, config, ats = null, deps = {} } = {}) {
  assertProbeAllowed(url);
  // A real file for the upload slot to check, so a missing file is never
  // mistaken for a form that cannot take one. Removed afterwards.
  const scratch = mkdtempSync(join(tmpdir(), 'jobagent-probe-'));
  const resume = join(scratch, 'probe-resume.txt');
  writeFileSync(resume, 'probe');
  try {
    const result = await assistApply({
      packet: {
        job: { id: 'coverage-probe', url }, blockers: [], owner: {},
        fillPlan: { steps: [], uploads: [{ type: 'resume', path: resume }] }, screeningPlan: { answered: [], needsUser: [] },
      },
      config,
      options: { headless: true, statePath: false, dryRun: true, maxSteps: 1 },
      deps: { createSession: async () => ({ page, close: async () => {} }), ...deps },
    });
    const scope = await resolveFormScope(page);
    const scanned = applicationFields(await scanFields(scope));

    const mappedSelectors = new Set((result.filled ?? []).map((f) => f.selector).filter(Boolean));
    const askLabels = new Set((result.needsUser ?? []).map((q) => String(q.label ?? '').trim().toLowerCase()));
    const fields = scanned.map((f) => {
      const label = String(f.label || f.name || '(unlabelled)').trim().slice(0, 160);
      let status = 'not_filled';
      if (f.kind === 'file') status = 'upload';
      else if (mappedSelectors.has(f.selector)) status = 'mapped';
      else if (f.hasValue) status = 'prefilled';
      else if (askLabels.has(label.toLowerCase())) status = 'needs_you';
      return { label, kind: f.kind ?? 'text', required: f.required === true, status };
    });
    const count = (status) => fields.filter((f) => f.status === status).length;
    const parsed = new URL(url);
    return {
      at: new Date().toISOString(),
      ats: ats ?? detectAts({ url }).platform,
      host: parsed.hostname,
      path: parsed.pathname,
      found: fields.length,
      mapped: count('mapped'),
      needsYou: count('needs_you'),
      requiredNeedsYou: fields.filter((f) => f.status === 'needs_you' && f.required).length,
      uploads: count('upload'),
      advance: result.wouldClick ?? null,
      fields,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const storeFile = (root) => join(workspacePaths(root).dataDir, FILE);

/** Every stored record, newest first. */
export function readCoverage(root) {
  try {
    const parsed = JSON.parse(readFileSync(storeFile(root), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Store a record, newest first, keeping the last 200.
 * @param {string} root workspace root
 * @param {object} record from probeForm
 */
export function recordCoverage(root, record) {
  const file = storeFile(root);
  mkdirSync(join(file, '..'), { recursive: true });
  const all = [record, ...readCoverage(root)].slice(0, KEEP);
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(all)}\n`, 'utf8');
  renameSync(temp, file);
  return all.length;
}

/**
 * Per-platform summary of stored records.
 * @param {object[]} records
 * @returns {{rows: object[], basis: string, live: boolean}}
 */
export function coverageTable(records = []) {
  const byAts = new Map();
  for (const r of records) {
    const row = byAts.get(r.ats) ?? { ats: r.ats, forms: 0, found: 0, mapped: 0, needsYou: 0, requiredNeedsYou: 0, lastProbed: null };
    row.forms += 1;
    row.found += r.found ?? 0;
    row.mapped += r.mapped ?? 0;
    row.needsYou += r.needsYou ?? 0;
    row.requiredNeedsYou += r.requiredNeedsYou ?? 0;
    if (!row.lastProbed || String(r.at) > row.lastProbed) row.lastProbed = r.at;
    byAts.set(r.ats, row);
  }
  const rows = [...byAts.values()]
    .map((row) => ({ ...row, percent: row.found ? Math.round((row.mapped / row.found) * 100) : 0 }))
    .sort((a, b) => a.ats.localeCompare(b.ats));
  return {
    rows,
    // Said on the table itself, so no one reads it as a live measurement.
    basis: 'Measured on saved pages and local fixtures, first page of each form. No live site has been probed.',
    live: false,
  };
}

/**
 * The questions a form asks, from its latest probe (audit A13): a packet knows
 * them before auto-fill starts, instead of learning them mid-run. Matched by
 * host and path (not query). No values are stored, so none are returned.
 *
 * @param {string} root
 * @param {string} url the application URL
 * @returns {Array<{label: string, kind: string, required: boolean}>}
 */
export function formFieldsFor(root, url) {
  let parsed;
  try { parsed = new URL(url); } catch { return []; }
  const hit = readCoverage(root).find((r) => r.host === parsed.hostname && r.path === parsed.pathname);
  return (hit?.fields ?? [])
    .filter((f) => f.kind !== 'file')
    .map((f) => ({ label: f.label, kind: f.kind, required: f.required === true }));
}

/**
 * The REQUIRED questions a probed form asks, for a packet to carry (audit A13).
 * Required only: an unanswered optional question never blocks a live run, so it
 * must not block a packet either.
 */
export function requiredFormFieldsFor(root, url) {
  return formFieldsFor(root, url).filter((f) => f.required);
}

export const COVERAGE_FILE = FILE;
