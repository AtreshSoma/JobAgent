/**
 * Interview prep pack (audit F10).
 *
 * When an application reaches Interviewing, one page brings together what the
 * person needs to prepare: each requirement the posting names beside the
 * resume line that shows it, the requirements no line shows (the gaps to
 * prepare for), the conditions buried in the posting, and the documents that
 * were submitted. Everything is quoted from what JobAgent already holds: no
 * model, nothing written for the person.
 */
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPrepPack, renderPrepPackHtml } from '../../src/dashboard/prepPack.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { openDatabase } from '../../src/logging/db.js';
import { buildTestRoot } from './globalSetup.js';

const detail = {
  id: 'j1', company: 'Globex', title: 'Senior Data Engineer', url: 'https://jobs.example.test/1', location: 'Remote',
  pay: { label: '$120,000 to $150,000 a year (compensation field)' },
  evidence: [
    { term: 'Python', lines: ['Built Airflow pipelines in Python for 12 teams.'] },
    { term: 'Kafka', lines: [] },
  ],
  unlistedRequirements: [
    { phrase: 'Dagster', inResume: false, preferred: false },
    { phrase: 'data contracts', inResume: true, preferred: true },
  ],
  clauses: [{ kind: 'onsite', label: 'Onsite 3 days a week', quote: 'This role is onsite three days a week in Austin.' }],
  application: { stage: 'interviewing', appliedOn: '2026-11-01' },
};
const versions = [
  { n: 1, at: '2026-10-30T10:00:00Z', files: { resume: 'Resume.docx' }, frozen: false },
  { n: 2, at: '2026-11-01T09:00:00Z', files: { resume: 'Resume.docx', coverLetter: 'Cover_Letter.txt' }, frozen: true },
];

describe('buildPrepPack', () => {
  const pack = buildPrepPack(detail, { versions });

  it('puts each requirement beside the resume line that shows it', () => {
    expect(pack.shown).toEqual([{ requirement: 'Python', lines: ['Built Airflow pipelines in Python for 12 teams.'] }]);
  });

  it('lists the gaps to prepare for: requirements no resume line shows', () => {
    expect(pack.gaps.map((g) => g.requirement)).toEqual(['Kafka', 'Dagster']);
    expect(pack.gaps.find((g) => g.requirement === 'Dagster').note).toMatch(/posting names it/i);
  });

  it('keeps the posting\'s buried conditions, with the sentence they came from', () => {
    expect(pack.conditions).toEqual([{ label: 'Onsite 3 days a week', quote: 'This role is onsite three days a week in Austin.' }]);
  });

  it('names the documents that were submitted: the frozen version', () => {
    expect(pack.documents).toMatchObject({ version: 2, frozen: true, files: ['Resume.docx', 'Cover_Letter.txt'] });
  });

  it('carries the job facts and says nothing was written for the person', () => {
    expect(pack).toMatchObject({ company: 'Globex', title: 'Senior Data Engineer', pay: expect.stringMatching(/\$120,000/), appliedOn: '2026-11-01' });
    expect(pack.basis).toMatch(/quoted|no model/i);
  });

  it('without a master resume, says the evidence is unavailable instead of calling everything a gap', () => {
    const p = buildPrepPack({ ...detail, evidence: null }, { versions: [] });
    expect(p.shown).toEqual([]);
    expect(p.gaps.map((g) => g.requirement)).toEqual(['Dagster']);
    expect(p.evidenceAvailable).toBe(false);
    expect(p.documents).toBeNull();
  });
});

describe('renderPrepPackHtml', () => {
  it('is one page with every section, escapes what it quotes, and has no script', () => {
    const html = renderPrepPackHtml(buildPrepPack({ ...detail, company: 'Globex <script>alert(1)</script>' }, { versions }));
    expect(html).toContain('Gaps to prepare for');
    expect(html).toContain('Conditions in the posting');
    expect(html).toContain('What you submitted');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/ on[a-z]+=/i);
    expect(renderPrepPackHtml(buildPrepPack({ ...detail, url: 'javascript:alert(1)' }, { versions }))).not.toContain('javascript:');
  });
});

describe('GET /api/jobs/:id/prep-pack', () => {
  let root; let db; let dash;
  beforeEach(async () => {
    root = buildTestRoot();
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'j1', company: 'Globex', title: 'Data Engineer', status: 'scored', score: 70, jd_text: 'Requirements\n- Python\nThis role is onsite three days a week.', discovery_mode: 'profile' });
    const load = ({ root: r = root } = {}) => loadConfig({ root: r, loadEnv: false, env: {} });
    dash = await startDashboard({ config: load(), db, logger: null, port: 0, deps: { loadConfigImpl: load } });
  });
  afterEach(async () => { await dash.close(); db.close(); rmSync(root, { recursive: true, force: true }); });

  it('serves the pack for a job', async () => {
    const res = await fetch(`${dash.url}/api/jobs/j1/prep-pack`);
    expect(res.status).toBe(200);
    const pack = await res.json();
    expect(pack).toMatchObject({ company: 'Globex', title: 'Data Engineer' });
    expect(Array.isArray(pack.gaps)).toBe(true);
    expect(Array.isArray(pack.conditions)).toBe(true);
  });

  it('serves the printable page as HTML, under the dashboard CSP', async () => {
    const res = await fetch(`${dash.url}/api/jobs/j1/prep-page`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'self'/);
    expect(await res.text()).toContain('Globex: Data Engineer');
  });

  it('is a 404 for an unknown job', async () => {
    expect((await fetch(`${dash.url}/api/jobs/nope/prep-pack`)).status).toBe(404);
  });
});
