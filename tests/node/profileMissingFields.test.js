/**
 * The setup checklist's "Candidate profile (required fields)" item, end to end.
 *
 * It named fields (sponsorship, work authorization) that had no box anywhere in
 * the dashboard, and its button opened the Application profile at the top. Now
 * both fields are in the form, the button opens it AT the missing boxes, each
 * is marked in red until it holds a value, and a save takes the line off the
 * checklist. Sponsorship stays a statement only the person makes: tri-state,
 * never guessed, and refused when it contradicts a saved screening answer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readProfile, writeProfile } from '../../src/config/profileStore.js';
import { activateProfile, migrateLegacyCandidate, readActiveProfile } from '../../src/profile/store.js';
import { runDoctor } from '../../src/cli/doctor.js';
import { browserUnavailable } from './helpers/browser.js';
import { launchBrowser, startTestDashboard, waitUntilConnected } from './helpers/dashboardPage.js';

const REPO = process.cwd();
const SPONSOR = 'workAuthorization.requiresSponsorship';

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jobagent-missing-'));
  mkdirSync(join(root, 'config', 'schemas'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  for (const file of ['scoring.json', 'exclusions.json', 'jobboards.json', 'humanizer_patterns.json', 'ats_resume.json', 'role_families.json']) {
    copyFileSync(join(REPO, 'config', file), join(root, 'config', file));
  }
  copyFileSync(join(REPO, 'config', 'cover_letter.example.json'), join(root, 'config', 'cover_letter.json'));
  copyFileSync(join(REPO, 'tests', 'node', 'fixtures', 'config', 'candidate.json'), join(root, 'config', 'candidate.json'));
  copyFileSync(join(REPO, 'tests', 'node', 'fixtures', 'config', 'screening_answers.json'), join(root, 'config', 'screening_answers.json'));
  for (const schema of ['candidate', 'scoring', 'exclusions', 'jobboards', 'cover_letter', 'ats_resume']) {
    copyFileSync(join(REPO, 'config', 'schemas', `${schema}.schema.json`), join(root, 'config', 'schemas', `${schema}.schema.json`));
  }
  writeFileSync(join(root, '.env'), '');
  return root;
}

const candidate = (root) => JSON.parse(readFileSync(join(root, 'config', 'candidate.json'), 'utf8'));
const field = (root, path) => readProfile(root).fields.find((f) => f.path === path);

describe('work authorization in the Application profile', () => {
  let root;
  beforeEach(() => { root = makeRoot(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('shows sponsorship as a choice and an unstated status as empty', () => {
    // The fixture is an H-1B holder who needs sponsorship.
    expect(field(root, SPONSOR)).toMatchObject({ type: 'choice', value: 'yes', filled: true, required: true });
    writeProfile(root, { [SPONSOR]: '', 'workAuthorization.status': '' });
    expect(field(root, SPONSOR)).toMatchObject({ value: '', filled: false });
    expect(field(root, 'workAuthorization.status')).toMatchObject({ value: '', filled: false });
    expect(readProfile(root).missing).toEqual(expect.arrayContaining(['requiresSponsorship', 'workAuthStatus']));
    // Stored the way the schema and the doctor read it: null is "not stated", never "no".
    const c = candidate(root);
    expect(c.workAuthorization.requiresSponsorship).toBeNull();
    expect(c.sponsorshipRequired).toBeNull();
    expect(c.workAuthorization.status).toBe('Unspecified');
  });

  it('stores yes as true in both places, and refuses anything but yes, no or blank', () => {
    writeProfile(root, { [SPONSOR]: '' });
    const out = writeProfile(root, { [SPONSOR]: 'yes' });
    expect(out.changed).toContain(SPONSOR);
    expect(candidate(root).workAuthorization.requiresSponsorship).toBe(true);
    expect(candidate(root).sponsorshipRequired).toBe(true);
    expect(() => writeProfile(root, { [SPONSOR]: 'maybe' })).toThrow(/yes, no, or left unanswered/);
  });

  it('refuses a sponsorship setting that contradicts a saved answer, and says which box', () => {
    const before = readFileSync(join(root, 'config', 'candidate.json'), 'utf8');
    let error;
    try { writeProfile(root, { [SPONSOR]: 'no', 'contact.phone': '+1 512 555 0100' }); } catch (err) { error = err; }
    expect(error?.message).toMatch(/^Not saved\. Your saved answer "require_sponsorship" says you will need sponsorship/);
    expect(error.fields[SPONSOR]).toMatch(/Saved answers/);
    // Nothing was written, the phone included: one save, all or nothing.
    expect(readFileSync(join(root, 'config', 'candidate.json'), 'utf8')).toBe(before);
  });

  it('writes through to the active search profile, so the answer survives the next activation', () => {
    const id = migrateLegacyCandidate(root).id ?? readActiveProfile(root).id;
    activateProfile(root, id);
    writeProfile(root, { [SPONSOR]: '', 'workAuthorization.status': 'Green card' });
    expect(readActiveProfile(root).searchIntent.workAuthorization).toMatchObject({ requiresSponsorship: null, status: 'Green card' });
    activateProfile(root, id);
    expect(candidate(root).workAuthorization).toMatchObject({ requiresSponsorship: null, status: 'Green card' });
  });

  it('the doctor names the empty fields by path, for the checklist button', async () => {
    writeProfile(root, { [SPONSOR]: '', 'contact.phone': '' });
    const report = await runDoctor({ root, env: {}, deps: { spawnImpl: () => ({ status: 1, stdout: '', stderr: '' }) } });
    const check = report.checks.find((c) => c.id === 'profile');
    expect(check.status).toBe('fail');
    expect(check.fields.map((f) => f.path)).toEqual(['contact.phone', SPONSOR]);
  });
});

describe('the checklist opens the profile at the missing boxes', { timeout: 120_000 }, () => {
  let browser;
  let dash;
  let available = true;

  beforeAll(async () => {
    dash = await startTestDashboard({
      prepare(r) {
        const file = join(r, 'config', 'candidate.json');
        const c = JSON.parse(readFileSync(file, 'utf8'));
        c.workAuthorization = { ...c.workAuthorization, requiresSponsorship: null };
        c.sponsorshipRequired = null;
        c.contact = { ...c.contact, phone: '' };
        writeFileSync(file, JSON.stringify(c, null, 2));
      },
    });
    try { browser = await launchBrowser(); } catch (err) { available = browserUnavailable(err); }
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await dash?.stop();
  }, 60_000);

  it('marks each missing box in red until it is filled, and a save clears the checklist line', async (ctx) => {
    if (!available) return ctx.skip();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${dash.url}/`);
      await waitUntilConnected(page);
      const card = page.locator('#setupChecklist .setup-card');
      await card.waitFor({ timeout: 60_000 });
      // Plain words, no config paths.
      await expect.poll(() => card.innerText()).toMatch(/Missing: phone and sponsorship requirement/);
      expect(await card.innerText()).not.toMatch(/workAuthorization|contact\./);
      await card.getByRole('button', { name: 'Fill in 2 fields' }).click();

      const dialog = page.locator('#dlgProfile[open]');
      await dialog.locator('.pf-missing').waitFor();
      // The cursor is in the first missing box.
      await expect.poll(() => page.evaluate(() => document.activeElement?.dataset?.path)).toBe('contact.phone');
      const marked = () => dialog.locator('.pf-cell.is-missing [data-path]').evaluateAll((n) => n.map((x) => x.dataset.path));
      expect(await marked()).toEqual(['contact.phone', SPONSOR]);
      expect(await dialog.locator('.pf-cell.is-missing .pf-need').first().innerText()).toBe('Missing');
      // Red is the box itself, not colour alone: a border in --bad and a word.
      const border = await dialog.locator('[data-path="contact.phone"]').evaluate((n) => getComputedStyle(n).borderTopColor);
      const bad = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--bad)';
        document.body.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      });
      expect(border).toBe(bad);

      // Typing takes the red off at once; clearing puts it back.
      await dialog.locator('[data-path="contact.phone"]').fill('+1 512 555 0100');
      expect(await marked()).toEqual([SPONSOR]);
      expect(await dialog.locator('.pf-cell.is-filled .pf-need').innerText()).toBe('Ready to save');
      expect(await page.locator('#pfMissingCount').innerText()).toBe('1 to fill');
      await dialog.locator('[data-path="contact.phone"]').fill('');
      expect(await marked()).toEqual(['contact.phone', SPONSOR]);
      await dialog.locator('[data-path="contact.phone"]').fill('+1 512 555 0100');

      // A name in the list goes to its box.
      await dialog.locator('.pf-missing-chip[data-go="workAuthorization.requiresSponsorship"]').click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.dataset?.path)).toBe(SPONSOR);

      // The fixture needs sponsorship: "No" is refused at the box.
      await dialog.locator(`[data-path="${SPONSOR}"]`).selectOption('no');
      await page.locator('#saveDetailsBtn').click();
      await expect.poll(() => page.locator('#pf-err-requiresSponsorship').innerText()).toMatch(/says you will need sponsorship/);

      // The truthful answer saves, the marks go, and so does the checklist line.
      await dialog.locator(`[data-path="${SPONSOR}"]`).selectOption('yes');
      await page.locator('#saveDetailsBtn').click();
      await expect.poll(() => page.locator('#profileMsg').innerText()).toBe('Saved.');
      expect(await dialog.locator('.pf-cell.is-missing').count()).toBe(0);
      await expect.poll(() => page.locator('#setupChecklist .setup-card').count(), { timeout: 60_000 }).toBe(0);
      const stored = JSON.parse(readFileSync(join(dash.root, 'config', 'candidate.json'), 'utf8'));
      expect(stored.contact.phone).toBe('+1 512 555 0100');
      expect(stored.workAuthorization.requiresSponsorship).toBe(true);
    } finally {
      await page.close();
    }
  });
});
