/**
 * Questions that reveal questions (audit A7).
 *
 * The filler scanned each page, filled it, re-scanned ONCE, and filled what
 * the first answers revealed. A form where an answer reveals a question whose
 * answer reveals a third was filled two levels deep and the third was left
 * for the person (or reported as missing). It now re-scans until a pass
 * fills nothing new, up to MAX_RESCANS passes, so a form that keeps revealing
 * fields cannot hold the run forever.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import { assistApply } from '../../src/automation/applyRunner.js';
import { MAX_RESCANS } from '../../src/automation/assistStages.js';
import { launchOrSkip, skipWithoutBrowser } from './helpers/browser.js';

const ORIGIN = 'https://jobs.example.test';

const THREE_DEEP = `<!doctype html><title>Apply</title><form>
  <label for="a">Are you willing to relocate?</label>
  <select id="a"><option value=""></option><option>Yes</option><option>No</option></select>
  <div id="bw" hidden><label for="b">Are you open to hybrid work?</label>
    <select id="b"><option value=""></option><option>Yes</option><option>No</option></select></div>
  <div id="cw" hidden><label for="c">Which cities would you consider?</label><input id="c"></div>
</form>
<script>
  a.addEventListener('change', () => { bw.hidden = false; });
  b.addEventListener('change', () => { cw.hidden = false; });
</script>`;

// Every answered question reveals the next one, without end. (Patterns need two
// subject words: a lone keyword never answers a longer question, by design.)
const ENDLESS = `<!doctype html><title>Apply</title><form id="f">
  <label for="q1">Do you accept condition 1?</label><select id="q1" data-n="1"><option value=""></option><option>Yes</option></select>
</form>
<script>
  function wire(sel) {
    sel.addEventListener('change', () => {
      const n = Number(sel.dataset.n) + 1;
      const label = document.createElement('label'); label.htmlFor = 'q' + n; label.textContent = 'Do you accept condition ' + n + '?';
      const next = document.createElement('select'); next.id = 'q' + n; next.dataset.n = n;
      next.innerHTML = '<option value=""></option><option>Yes</option>';
      document.getElementById('f').append(label, next); wire(next);
    });
  }
  wire(q1);
</script>`;

const config = (answers) => ({
  candidate: { identity: { fullName: 'Dana Okafor' }, contact: { email: 'dana@example.test' } },
  screeningAnswers: { answers }, runtime: {},
});
const packet = {
  job: { id: 'rescan-1', url: `${ORIGIN}/apply` }, blockers: [], owner: { candidateName: 'Dana Okafor' },
  fillPlan: { steps: [], uploads: [] }, screeningPlan: { answered: [], needsUser: [] },
};

describe('re-scanning a page until it stops revealing questions', () => {
  let browser;
  beforeAll(async () => { browser = await launchOrSkip(() => chromium.launch({ headless: true })); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);
  skipWithoutBrowser(() => browser);

  async function run(html, answers) {
    const context = await browser.newContext();
    await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    const page = await context.newPage();
    const result = await assistApply({
      packet, config: config(answers),
      options: { headless: true, statePath: false, maxSteps: 1 },
      deps: { createSession: async () => ({ page, close: async () => {} }) },
    });
    return { result, page, context };
  }

  it('fills a question revealed by a question revealed by a question', async () => {
    const { result, page, context } = await run(THREE_DEEP, [
      { id: 'relocate', patterns: ['willing to relocate'], answer: 'Yes' },
      { id: 'hybrid', patterns: ['open to hybrid'], answer: 'Yes' },
      { id: 'cities', patterns: ['cities would you consider'], answer: 'Raleigh or Durham' },
    ]);
    expect(await page.inputValue('#a')).toBe('Yes');
    expect(await page.inputValue('#b')).toBe('Yes');
    expect(await page.inputValue('#c')).toBe('Raleigh or Durham');
    expect(result.needsUser.map((q) => q.label)).toEqual([]);
    await context.close();
  }, 60_000);

  it('stops after MAX_RESCANS passes on a form that never stops revealing', async () => {
    const { result, page, context } = await run(ENDLESS, [{ id: 'q', patterns: ['accept condition'], answer: 'Yes' }]);
    const answered = await page.$$eval('select', (nodes) => nodes.filter((n) => n.value === 'Yes').length);
    expect(answered).toBe(1 + MAX_RESCANS);
    expect(result.filled).toHaveLength(1 + MAX_RESCANS);
    await context.close();
  }, 60_000);
});
