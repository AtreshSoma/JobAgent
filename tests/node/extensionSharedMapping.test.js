/**
 * The extension uses the runner's field mapping (audit A12).
 *
 * The extension had its own, simpler label matcher: it filled "Reference
 * email" with the candidate's email, and fixes to the main filler never
 * reached it. The label classification now lives in ONE module
 * (src/shared/fieldLabels.js). The extension loads a generated classic-script
 * copy of it (extension/fieldLabels.js, made by `npm run sync:extension`), and
 * a test fails if that copy is out of date.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import { classifyLabel } from '../../src/apply/formPrefill.js';
import { classifyLabel as sharedClassify } from '../../src/shared/fieldLabels.js';
import { generateExtensionFieldLabels } from '../../scripts/syncExtension.mjs';
import { launchOrSkip, skipWithoutBrowser } from './helpers/browser.js';

describe('one mapping module', () => {
  it('the runner and the shared module are the same function', () => {
    expect(classifyLabel).toBe(sharedClassify);
  });

  it('the extension copy is the generated one (run `npm run sync:extension` if this fails)', () => {
    expect(readFileSync(resolve('extension/fieldLabels.js'), 'utf8')).toBe(generateExtensionFieldLabels());
  });
});

const LABELS = [
  'First name', 'Last Name', 'Preferred name', 'Full name', 'Email', 'E-mail address', 'Phone', 'Mobile number',
  'Phone extension', 'Phone device type', 'Country phone code', 'Street address', 'Address line 2', 'City',
  'State', 'State any certifications you hold', 'Zip code', 'Postal code', 'Country', 'Country of citizenship',
  'Current location', 'Preferred work location', 'LinkedIn profile', 'GitHub', 'Portfolio website',
  'Current employer', 'Reference email', 'Emergency contact phone', 'Previous employer', 'Middle name',
  'Signature (type your full name)', 'School name', 'Website address', 'Name', 'Your name', 'First and Last Name',
];

describe('the extension content script', () => {
  let browser;
  beforeAll(async () => { browser = await launchOrSkip(() => chromium.launch({ headless: true })); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);
  skipWithoutBrowser(() => browser);

  async function pageWithExtension(html, { withMapping = true } = {}) {
    const page = await browser.newPage();
    await page.evaluate(() => {
      globalThis.chrome = { runtime: { onMessage: { addListener(fn) { globalThis.__jobAgentListener = fn; } }, sendMessage: async () => ({ ok: false }) } };
    });
    await page.setContent(html);
    if (withMapping) await page.addScriptTag({ path: resolve('extension/fieldLabels.js') });
    await page.addScriptTag({ path: resolve('extension/content.js') });
    return page;
  }
  const fill = (page, profile) => page.evaluate((p) => new Promise((done) => {
    globalThis.__jobAgentListener({ type: 'JOB_AGENT_FILL', payload: { job: { id: 'j' }, artifacts: {}, profile: p, screeningAnswers: [] }, connection: { trustedHost: true } }, null, done);
  }), profile);

  it('classifies every label exactly as the runner does', async () => {
    const page = await pageWithExtension('<p>x</p>');
    const inPage = await page.evaluate((labels) => labels.map((l) => globalThis.JobAgentFieldLabels.classifyLabel(l)), LABELS);
    expect(inPage).toEqual(LABELS.map((l) => classifyLabel(l)));
    await page.close();
  }, 30_000);

  it('no longer fills a reference or emergency-contact box with the candidate\'s own details', async () => {
    const page = await pageWithExtension(`<form id="application">
      <label>Email <input id="email" type="email"></label>
      <label>Reference email <input id="refmail" type="email"></label>
      <label>Emergency contact phone <input id="emerg"></label>
      <label>Previous employer <input id="prev"></label></form>`);
    await fill(page, { identity: { fullName: 'Ada Lovelace' }, contact: { email: 'ada@example.test', phone: '5550100' } });
    expect(await page.inputValue('#email')).toBe('ada@example.test');
    expect(await page.inputValue('#refmail')).toBe('');
    expect(await page.inputValue('#emerg')).toBe('');
    expect(await page.inputValue('#prev')).toBe('');
    await page.close();
  }, 30_000);

  it('says so, and fills nothing, when the shared mapping did not load', async () => {
    const page = await pageWithExtension('<form id="application"><label>Email <input id="email"></label></form>', { withMapping: false });
    const result = await fill(page, { contact: { email: 'ada@example.test' } });
    expect(await page.inputValue('#email')).toBe('');
    expect(result.blockers.join(' ')).toMatch(/extension files|reload the extension/i);
    await page.close();
  }, 30_000);

  it('reads past 160 controls', async () => {
    const many = Array.from({ length: 220 }, (_, i) => `<label>Question ${i} <input></label>`).join('');
    const page = await pageWithExtension(`<form id="application"><label>First name <input id="first"></label>${many}<label>Email <input id="email"></label></form>`);
    await fill(page, { identity: { fullName: 'Ada Lovelace' }, contact: { email: 'ada@example.test' } });
    expect(await page.inputValue('#email')).toBe('ada@example.test'); // control number 222
    await page.close();
  }, 30_000);
});
