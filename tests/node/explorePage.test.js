/**
 * Explore JobAgent in a real browser, served by the real dashboard under its
 * real Content-Security-Policy (`script-src 'self'`).
 *
 * Covers what only a browser can show: the page builds with no console or CSP
 * errors, the dashboard's header link opens it, the example posting is held at
 * each signal until it is cleared, the scenes hold and play as the page is
 * scrolled (and simply play on a phone, and stand still for reduced motion),
 * the diagrams respond to pointer and keyboard, a deep link lands on its
 * section, the story can be told for any of six fields and the choice rides
 * in the link, the theme is shared with the dashboard, nothing overflows from
 * 320px up, and axe finds no WCAG A/AA problem in either section, theme or width.
 *
 * Self-skips when no browser can launch, like the other browser suites.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { browserUnavailable } from './helpers/browser.js';
import { launchBrowser, startTestDashboard, waitUntilConnected } from './helpers/dashboardPage.js';
import { DEEP_TOPICS } from '../../src/dashboard/public/assets/explore/js/content-deep.js';
import {
  JOURNEY, CAPABILITIES, CAPABILITY_AREAS, FIELDS, FAQ, SOURCES, TIER_GLOSS, marks, tailorLedger,
} from '../../src/dashboard/public/assets/explore/js/content-overview.js';
import { scoreInputs } from '../../src/dashboard/public/assets/explore/js/score-model.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PUBLIC = join(process.cwd(), 'src', 'dashboard', 'public');
const EXPLORE = join(PUBLIC, 'assets', 'explore');
const PAGE = '/assets/explore/index.html';
const HOOK_TIMEOUT = 60_000;

let browser;
let dash;
let available = true;

beforeAll(async () => {
  dash = await startTestDashboard();
  try {
    browser = await launchBrowser();
  } catch (err) {
    available = browserUnavailable(err);
  }
}, HOOK_TIMEOUT);

afterAll(async () => {
  await browser?.close();
  await dash?.stop();
}, HOOK_TIMEOUT);

/** Open the Explore page and fail the test on any console error, page error or CSP violation. */
async function withExplore(fn, { hash = '', viewport = { width: 1280, height: 900 }, theme = 'dark', bypassCSP = false, motion = false } = {}) {
  const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: motion ? 'no-preference' : 'reduce', bypassCSP });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(`${dash.url}${PAGE}${hash}`);
    await page.waitForSelector('html[data-ready="true"]');
    await fn(page, context);
    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await context.close();
  }
}

describe('Explore JobAgent: files', () => {
  it('uses no inline script or event handlers (the CSP would block them)', () => {
    const html = readFileSync(join(EXPLORE, 'index.html'), 'utf8');
    expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    for (const f of readdirSync(join(EXPLORE, 'js'))) {
      expect(readFileSync(join(EXPLORE, 'js', f), 'utf8'), f).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|\beval\(/);
    }
  });

  it('loads nothing from outside the app', () => {
    const files = ['index.html', 'explore.css', 'scenes.css', 'tokens.css', 'theme.js', ...readdirSync(join(EXPLORE, 'js')).map((f) => join('js', f))];
    for (const f of files) {
      const text = readFileSync(join(EXPLORE, f), 'utf8').replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '');
      expect(text, f).not.toMatch(/https?:\/\//);
    }
  });

  it('is linked from the dashboard header by a labelled icon, with a twin for small phones', () => {
    const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
    const header = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
    const link = header.match(/<a class="btn iconbtn explore-link"[^>]*>/)?.[0] ?? '';
    expect(link).toContain(`href="${PAGE}"`);
    expect(link).toMatch(/aria-label="Explore JobAgent[^"]+"/);
    expect(link).toMatch(/title="[^"]+"/);
    expect(link).toContain('rel="noopener"');
    expect(header).toMatch(new RegExp(`<a role="menuitem" class="btn only-narrow" href="${PAGE}"[^>]*>Explore JobAgent</a>`));
    // Line endings are normalised: Windows checkouts use CRLF.
    const css = readFileSync(join(PUBLIC, 'assets', 'css', 'app.css'), 'utf8').replace(/\r\n/g, '\n');
    // Hidden in the same small-phone block that hides the theme button.
    const narrow = css.slice(css.indexOf('@media (max-width: 480px) {\n  .theme-toggle { display: none; }'));
    expect(narrow.slice(0, 400)).toContain('.explore-link { display: none; }');
  });
});

describe('Explore JobAgent: served by the dashboard', { timeout: 120_000 }, () => {
  it('answers /explore with a redirect to the page, and serves the page with the CSP', async () => {
    const short = await fetch(`${dash.url}/explore`, { redirect: 'manual' });
    expect(short.status).toBe(302);
    expect(short.headers.get('location')).toBe(PAGE);
    const page = await fetch(`${dash.url}${PAGE}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
  });

  it('opens from the dashboard header in a new tab', async (ctx) => {
    if (!available) return ctx.skip();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.goto(`${dash.url}/`);
      await waitUntilConnected(page);
      const link = page.locator('header .explore-link');
      await expect.poll(() => link.isVisible()).toBe(true);
      const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
      await popup.waitForSelector('html[data-ready="true"]');
      expect(new URL(popup.url()).pathname).toBe(PAGE);
      expect(await popup.locator('h1').first().textContent()).toBe('All the work. Your call.');
      // The dashboard tab is left exactly where it was.
      expect(new URL(page.url()).pathname).toBe('/');
    } finally {
      await context.close();
    }
  });

  it('runs the example posting along the route and holds it at each signal', async (ctx) => {
    if (!available) return ctx.skip();
    await withExplore(async (page) => {
      const route = page.locator('.ex-route');
      const live = route.locator('.ex-route-live');
      const approve = route.getByRole('button', { name: 'Approve' });
      const submit = route.getByRole('button', { name: 'Submit' });
      expect(await route.locator('.ex-stop-station').count()).toBe(JOURNEY.length);
      expect(await route.locator('.ex-stop-signal').count()).toBe(2);

      // It waits near the end of the page and sets off when it is first scrolled to.
      await page.waitForTimeout(600);
      expect(await route.getAttribute('data-state'), 'not started before it is seen').toBe('idle');
      await route.scrollIntoViewIfNeeded();
      // It travels on its own as far as the first signal, and no further.
      await expect.poll(() => route.getAttribute('data-state'), { timeout: 15_000 }).toBe('held');
      expect(await live.textContent()).toContain('Nothing is filled until you approve');
      expect(await approve.isEnabled()).toBe(true);
      expect(await submit.isEnabled()).toBe(false);
      await page.waitForTimeout(2200);
      expect(await route.getAttribute('data-state'), 'a held signal never times out').toBe('held');

      // Clearing it lets the posting on to the second signal. The keyboard works too.
      await approve.focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => submit.isEnabled(), { timeout: 15_000 }).toBe(true);
      expect(await live.textContent()).toContain('The final click is always yours');
      expect(await approve.isEnabled()).toBe(false);
      await submit.click();
      await expect.poll(() => route.getAttribute('data-state'), { timeout: 15_000 }).toBe('done');
      expect(await live.textContent()).toBe('Submitted by you. Now tracking replies.');

      // It can be run again, and starts held-free from the first station.
      await route.getByRole('button', { name: 'Run it again' }).click();
      expect(await live.textContent()).toContain('Found on the employer’s careers page');
      expect(await approve.isEnabled()).toBe(false);
    });
  });

  it('links each stop to its scene, and moves focus there', async (ctx) => {
    if (!available) return ctx.skip();
    await withExplore(async (page) => {
      expect(await page.locator('.ex-scene').count()).toBe(JOURNEY.length);
      expect(await page.locator('.ex-gate').count()).toBe(2);
      expect(await page.locator('.ex-gate-title').allTextContents()).toEqual(['You approve.', 'You submit.']);
      await page.locator('.ex-route').getByRole('link', { name: 'Score' }).click();
      expect(page.url()).toMatch(/#\/overview\/score$/);
      await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('station-score-name');
      for (const stage of JOURNEY) {
        // Each scene is an ordinary section. (A stage id once produced a class name that a
        // component used too, and the Fill scene became a zero-height sticky element.)
        expect(await page.locator(`#station-${stage.id}`).evaluate((el) => getComputedStyle(el).position), stage.id).toBe('relative');
        expect(await page.locator(`#station-${stage.id}-name`).textContent()).toBe(stage.name);
        expect(await page.locator(`#station-${stage.id} .ex-scene-claim`).textContent()).toBe(stage.title);
        // Every moment of the scene is listed, in order.
        expect(await page.locator(`#station-${stage.id} .ex-beat-text`).allTextContents(), stage.id).toEqual(stage.beats.map((b) => b.text));
      }
    });
    // A link straight to one station lands on it.
    await withExplore(async (page) => {
      await expect.poll(() => page.evaluate(() => {
        const top = document.getElementById('station-fill').getBoundingClientRect().top;
        return top >= 0 && top < window.innerHeight / 2;
      })).toBe(true);
    }, { hash: '#/overview/fill' });
  });

  it('scores, tailors and stops as the code does', async (ctx) => {
    if (!available) return ctx.skip();
    const field = FIELDS[0];
    const result = scoreInputs(field.inputs);
    await withExplore(async (page) => {
      // Score: the number is the model's, said in plain words, and a strong fit can still be held.
      const score = page.locator('#station-score');
      expect(await score.locator('.ex-score-num').textContent()).toBe(String(result.total));
      expect(await score.locator('.ex-tier').textContent()).toBe(result.tier);
      expect(await score.locator('.ex-score-gloss').textContent()).toBe(TIER_GLOSS[result.tier]);
      // The skills marked in the posting are the ones the score counts.
      expect(await score.locator('.ex-hit').allTextContents()).toEqual([...marks(field.posting.requires), ...marks(field.posting.prefers)]);
      // What the posting asks for beyond the profile is quoted, and the gap is never claimed.
      expect(await score.locator('.ex-ask q').allTextContents()).toEqual(field.alsoAsked);
      expect(await score.locator('.ex-ev .is-gap').textContent()).toContain('never added');
      await score.getByRole('button', { name: 'Visa needed, posting silent' }).click();
      expect(await score.locator('.ex-tier').textContent()).toBe('Queue');
      expect(await score.locator('.ex-score-note').textContent()).toContain('held in Queue');
      await score.getByRole('button', { name: 'This job' }).click();
      expect(await score.locator('.ex-score-num').textContent()).toBe(String(result.total));

      // Tailor: every tailored line is a master line, one is left out and listed, and nothing is added.
      const sheets = page.locator('#station-tailor .ex-sheet');
      const master = await sheets.nth(0).locator('.ex-sheet-text').allTextContents();
      const tailored = await sheets.nth(1).locator('.ex-sheet-text').allTextContents();
      expect(tailored.length).toBe(master.length - 1);
      for (const line of tailored) expect(master).toContain(line);
      expect(tailored).not.toEqual(master.filter((line) => tailored.includes(line)));
      expect(await sheets.nth(0).locator('.ex-kw').count()).toBe(0);
      expect(await sheets.nth(1).locator('.ex-kw').count()).toBeGreaterThan(3);
      const ledger = tailorLedger(field);
      expect(await page.locator('#station-tailor .ex-compare-cells dd').allTextContents())
        .toEqual([ledger.same, ledger.moved, ledger.reordered, ledger.reworded, ledger.omitted, ledger.added].map(String));
      expect(await page.locator('#station-tailor .ex-compare-cells .is-proof').textContent()).toBe('Added0');
      const left = master.find((line) => !tailored.includes(line));
      expect(await page.locator('#station-tailor .ex-compare-notes').textContent()).toContain(left);
      expect(await page.locator('#station-tailor .ex-compare-notes').textContent()).toContain('never added');

      // Fill: the form ends at the stop, Submit is not a control, and the open question is left alone.
      const fill = page.locator('#station-fill');
      expect(await fill.locator('.ex-halt-text').textContent()).toBe('JobAgent stops here');
      expect(await fill.getByRole('button').count()).toBe(0);
      expect(await fill.locator('.ex-field-ask .ex-field-ask').textContent()).toBe('Left for you');

      // Discover: the hidden condition is a tag that opens to its sentence, and folds away again.
      const tag = page.locator('#station-discover .ex-cond-tag');
      expect(await tag.textContent()).toBe(field.posting.condition.tag);
      expect(await tag.getAttribute('aria-expanded')).toBe('true');
      expect(await page.locator('#discoverCond').textContent()).toContain(field.posting.condition.sentence);
      await tag.focus();
      await page.keyboard.press('Enter');
      expect(await tag.getAttribute('aria-expanded')).toBe('false');
      expect(await page.locator('#discoverCond').isHidden()).toBe(true);
    });
  });

  it('tells the same story for each of six fields, and keeps the choice in the link', async (ctx) => {
    if (!available) return ctx.skip();
    await withExplore(async (page) => {
      const picks = page.getByRole('radiogroup', { name: /See it for your field/ });
      expect(await picks.getByRole('radio').count()).toBe(FIELDS.length);
      expect(await picks.getByRole('radio', { checked: true }).textContent()).toContain('Software Engineer');

      for (const field of FIELDS.slice(1)) {
        const result = scoreInputs(field.inputs);
        await picks.getByRole('radio', { name: field.label }).click();
        // The link carries it, a screen reader hears it, and focus stays on the choice just made.
        expect(page.url()).toContain(`?field=${field.id}`);
        expect(await page.getByRole('status').filter({ hasText: 'Showing the example' }).textContent()).toContain(`${field.label}: ${field.job.title} at ${field.job.company}`);
        expect(await page.evaluate(() => document.activeElement?.dataset.field)).toBe(field.id);
        // Every chapter is told for that field, with the model's own number.
        expect(await page.locator('.ex-fcard.is-ours .ex-fcard-title').textContent()).toBe(field.job.title);
        expect(await page.locator('.ex-fcard.is-ours .ex-fcard-num').textContent()).toBe(String(result.total));
        expect(await page.locator('#station-score .ex-score-num').textContent()).toBe(String(result.total));
        expect(await page.locator('#station-score .ex-tier').textContent()).toBe(result.tier);
        expect(await page.locator('#station-score .ex-posting-title').textContent()).toBe(field.job.title);
        expect(await page.locator('#station-discover .ex-board-kept .ex-board-title').textContent()).toBe(field.job.title);
        expect(await page.locator('#station-tailor .ex-sheet-role').first().textContent()).toBe(field.resume.role);
        expect(await page.locator('#station-fill .ex-field-value').first().textContent()).toBe(field.person.first);
        expect(await page.locator('#station-track .ex-app-title').textContent()).toBe(field.job.title);
        expect(await page.locator('.ex-route-job b').textContent()).toBe(field.job.title);
        expect(await page.locator('#signal-tailor .ex-gate-tag').textContent()).toBe(field.job.title);
        // The structure never changes: five chapters, two signals.
        expect(await page.locator('.ex-scene').count()).toBe(JOURNEY.length);
        expect(await page.locator('.ex-gate').count()).toBe(2);
      }

      // Arrow keys move between the choices, as in any radio group.
      await page.keyboard.press('ArrowRight');
      expect(await picks.getByRole('radio', { checked: true }).textContent()).toContain('Software Engineer');
      expect(page.url()).not.toContain('field=');
      await page.keyboard.press('ArrowRight');
      expect(page.url()).toContain('?field=security');

      // A link inside the page that names no field keeps the one in use.
      await page.locator('.ex-route').getByRole('link', { name: 'Tailor' }).click();
      await expect.poll(() => page.url()).toMatch(/#\/overview\/tailor\?field=security$/);
      // The control in a chapter's corner changes it too, and stays under the hand.
      const corner = page.locator('#station-tailor').getByLabel('Example');
      expect(await corner.inputValue()).toBe('security');
      await corner.selectOption('nursing');
      expect(page.url()).toMatch(/#\/overview\/tailor\?field=nursing$/);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pick-station-tailor');
      expect(await page.locator('#station-tailor .ex-sheet-role').first().textContent()).toBe(FIELDS.find((f) => f.id === 'nursing').resume.role);

      // It is remembered for the visit: the page opened again without a field still shows it.
      await page.goto(`${dash.url}${PAGE}`);
      await page.reload();
      await page.waitForSelector('html[data-ready="true"]');
      expect(await page.locator('.ex-fcard.is-ours .ex-fcard-title').textContent()).toBe(FIELDS.find((f) => f.id === 'nursing').job.title);
    });

    // A link straight to a chapter for a field lands on it, told for that field.
    const security = FIELDS.find((f) => f.id === 'security');
    await withExplore(async (page) => {
      expect(await page.locator('#station-score .ex-score-num').textContent()).toBe(String(scoreInputs(security.inputs).total));
      expect(await page.locator('#station-score .ex-posting-title').textContent()).toBe(security.job.title);
      await expect.poll(() => page.evaluate(() => {
        const top = document.getElementById('station-score').getBoundingClientRect().top;
        return top >= 0 && top < window.innerHeight / 2;
      })).toBe(true);
    }, { hash: '#/overview/score?field=security' });
    // A field that does not exist falls back to the first.
    await withExplore(async (page) => {
      expect(await page.locator('.ex-fcard.is-ours .ex-fcard-title').textContent()).toBe(FIELDS[0].job.title);
    }, { hash: '#/overview?field=astronaut' });
  });

  it('shows where jobs come from at a glance, and explores the register one capability at a time', async (ctx) => {
    if (!available) return ctx.skip();
    await withExplore(async (page) => {
      // Sources: three columns by what the reader has to do, each with its count.
      const sources = page.locator('#sources');
      for (const mode of ['on', 'key', 'urls']) {
        const col = sources.locator(`.ex-src-col[data-mode="${mode}"]`);
        const list = SOURCES.filter((src) => src.mode === mode);
        expect(await col.locator('.ex-src-n').textContent()).toBe(String(list.length));
        expect(await col.locator('.ex-source-name').allTextContents()).toEqual(list.map((src) => src.name));
      }
      expect(await sources.locator('.ex-source').count()).toBe(SOURCES.length);

      // The register: counts first, one area's names, one capability spelled out.
      const reg = page.locator('#ledger');
      const count = (status) => CAPABILITIES.filter((c) => c.status === status).length;
      await reg.scrollIntoViewIfNeeded();
      await expect.poll(() => reg.locator('.ex-reg-stat[data-status="shipped"] .ex-reg-n').textContent()).toBe(String(count('shipped')));
      const first = CAPABILITIES.filter((c) => c.area === CAPABILITY_AREAS[0]);
      expect(await reg.locator('.ex-reg-row').count()).toBe(first.length);
      expect(await reg.locator('.ex-reg-detail').count()).toBe(1);
      expect(await reg.locator('.ex-reg-detail-name').textContent()).toBe(first[0].name);
      expect(await reg.locator('.ex-reg-facts dt').allTextContents()).toEqual(['What it does', 'Why it matters', 'How it works']);
      expect(await reg.locator('.ex-reg-facts dd').allTextContents()).toEqual([first[0].what, first[0].why, first[0].how]);

      // Choosing a name spells it out; the arrow keys move through the list.
      await reg.locator('.ex-reg-area[data-area="Apply"]').click();
      await reg.getByRole('button', { name: /^Final auto-submit/ }).click();
      expect(await reg.locator('.ex-reg-detail .ex-status').textContent()).toBe('Experimental');
      expect(await reg.locator('.ex-reg-detail').textContent()).toContain('refused on every application system');
      expect(await reg.getByRole('button', { name: /^Final auto-submit/ }).getAttribute('aria-expanded')).toBe('true');
      await page.keyboard.press('ArrowUp');
      expect(await reg.locator('.ex-reg-detail-name').textContent()).toBe('Coverage check');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-expanded'))).toBe('true');

      // A count is a filter: Planned shows only what is not built, and says so.
      await reg.locator('.ex-reg-stat[data-status="planned"]').click();
      const planned = CAPABILITIES.filter((c) => c.status === 'planned');
      expect(await reg.locator('.ex-reg-note').textContent()).toContain('Not built');
      expect(await reg.locator('.ex-reg-row').count()).toBe(planned.filter((c) => c.area === 'Apply').length || planned.filter((c) => c.area === planned[0].area).length);
      expect(await reg.locator('.ex-reg-detail .ex-status').textContent()).toBe('Planned');
      expect(await reg.locator('.ex-reg-detail').textContent()).toContain('Not built.');
      // An area with nothing planned cannot be chosen while the filter is on.
      const empty = CAPABILITY_AREAS.find((a) => !planned.some((c) => c.area === a));
      expect(await reg.locator(`.ex-reg-area[data-area="${empty}"]`).isDisabled()).toBe(true);
      // Pressing the count again clears it.
      await reg.locator('.ex-reg-stat[data-status="planned"]').click();
      expect(await reg.locator(`.ex-reg-area[data-area="${empty}"]`).isDisabled()).toBe(false);

      // Questions a newcomer asks: all there, the first already open.
      expect(await page.locator('#faq .ex-faq-q').allTextContents()).toEqual(FAQ.map((item) => item.q));
      expect(await page.locator('#faq details[open]').count()).toBe(1);
      await page.locator('#faq summary').nth(1).click();
      expect(await page.locator('#faq .ex-faq-a').nth(1).isVisible()).toBe(true);
    });
  });

  it('switches to the deep dive, and a deep link lands on its section', async (ctx) => {
    if (!available) return ctx.skip();
    await withExplore(async (page) => {
      await page.getByRole('button', { name: 'Under the hood' }).click();
      await page.waitForSelector('#viewHow:not([hidden])');
      expect(page.url()).toMatch(/#\/how$/);
      expect(await page.locator('#viewOverview').isHidden()).toBe(true);
      expect(await page.locator('.ex-topic').count()).toBe(DEEP_TOPICS.length);
      expect(await page.locator('.ex-toc a').count()).toBe(DEEP_TOPICS.length);
      expect(await page.title()).toBe('How JobAgent works');

      // A link from the contents moves focus to the section's heading.
      await page.locator('.ex-toc a[data-topic="lifecycle"]').click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('topic-lifecycle-title');
      await expect.poll(() => page.locator('.ex-toc a[data-topic="lifecycle"]').getAttribute('aria-current')).toBe('true');

      await page.goBack();
      await page.goBack();
      await page.waitForSelector('#viewOverview:not([hidden])');
      expect(await page.locator('[data-view="overview"]').getAttribute('aria-pressed')).toBe('true');
    });

    await withExplore(async (page) => {
      expect(await page.locator('#viewHow').isVisible()).toBe(true);
      await expect.poll(() => page.evaluate(() => {
        const top = document.getElementById('topic-scoring').getBoundingClientRect().top;
        return top >= 0 && top < window.innerHeight / 2;
      })).toBe(true);
    }, { hash: '#/how/scoring' });
  });

  it('explains the system map, a feature flow and the lifecycle on selection', async (ctx) => {
    if (!available) return ctx.skip();
    await withExplore(async (page) => {
      const system = page.locator('#topic-system');
      expect(await system.locator('.ex-detail h3').textContent()).toBe('Pipeline');
      // At this width the map is a drawn network: stations sit on lines, and one line can be followed.
      expect(await system.locator('.ex-net-svg').isVisible()).toBe(true);
      expect(await system.locator('.ex-net-svg path').count()).toBeGreaterThan(5);
      await system.getByRole('button', { name: 'Apply' }).click();
      expect(await system.locator('.ex-map-board').getAttribute('data-focus')).toBe('apply');
      expect(await system.locator('[data-node="search"]').evaluate((el) => getComputedStyle(el).opacity)).not.toBe('1');
      expect(await system.locator('[data-node="packets"]').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
      await system.getByRole('button', { name: 'All lines' }).click();
      expect(await system.locator('.ex-map-board').getAttribute('data-focus')).toBeNull();
      await system.locator('[data-node="automation"]').click();
      expect(await system.locator('.ex-detail h3').textContent()).toBe('Browser assist');
      expect(await system.locator('[data-node="automation"]').getAttribute('aria-pressed')).toBe('true');
      expect(await system.locator('[data-node="sites"]').getAttribute('data-rel')).toBe('out');
      expect(await system.locator('[data-node="server"]').getAttribute('data-rel')).toBe('in');
      expect(await system.locator('.ex-files-list code').allTextContents()).toContain('src/automation/applyRunner.js');
      // A "calls" chip selects that part.
      await system.getByRole('button', { name: 'Show Packets and approval' }).click();
      expect(await system.locator('.ex-detail h3').textContent()).toBe('Packets and approval');

      const flow = page.locator('#topic-autofill .ex-flow');
      const steps = flow.locator('[role="tab"]');
      await steps.nth(2).click();
      expect(await flow.locator('.ex-flow-detail').textContent()).toContain('CAPTCHA');
      await page.keyboard.press('ArrowRight');
      expect(await steps.nth(3).getAttribute('aria-selected')).toBe('true');
      expect(await flow.locator('.ex-files-list code').allTextContents()).toEqual(['src/automation/domScanner.js']);

      const lifecycle = page.locator('#topic-lifecycle');
      await lifecycle.locator('[data-node="submitted"]').click();
      expect(await lifecycle.locator('.ex-detail').textContent()).toContain('Nothing. This state is final.');
      await lifecycle.locator('[data-node="ready_for_submit"]').click();
      expect(await lifecycle.locator('[data-node="submitted"]').getAttribute('data-rel')).toBe('out');
    }, { hash: '#/how' });
  });

  it('recomputes the Score Lab as its inputs change', async (ctx) => {
    if (!available) return ctx.skip();
    await withExplore(async (page) => {
      const lab = page.locator('#topic-scorelab');
      const score = lab.locator('.ex-verdict-score');
      const tier = lab.locator('.ex-verdict .ex-tier');
      expect([await score.textContent(), await tier.textContent()]).toEqual(['78', 'Apply']);

      await lab.getByRole('button', { name: 'Strong fit, sponsorship unknown' }).click();
      expect(await tier.textContent()).toBe('Queue');
      expect(await lab.locator('.ex-lab-held').textContent()).toContain('held in Queue');

      // Saying you need no sponsorship clears the hold and disables the question.
      await lab.getByLabel('You need visa sponsorship').uncheck();
      expect(await tier.textContent()).toBe('Priority');
      expect(await lab.getByLabel('The posting reads as').isDisabled()).toBe(true);

      await lab.getByLabel('A stated requirement').selectOption('ineligible');
      expect(await tier.textContent()).toBe('Queue');
      expect(await lab.locator('.ex-lab-table .is-penalty').count()).toBe(1);

      // "Only under nice to have" can never exceed the skills found.
      await lab.getByLabel('Your skills found in the posting').fill('2');
      expect(await lab.getByLabel(/^Of those, named only under/).getAttribute('max')).toBe('2');
    }, { hash: '#/how/scorelab' });
  });

  it('shares its theme with the dashboard', async (ctx) => {
    if (!available) return ctx.skip();
    await withExplore(async (page) => {
      const toggle = page.locator('.theme-toggle');
      expect(await toggle.getAttribute('aria-label')).toBe('Switch to light theme');
      await toggle.click();
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
      expect(await page.evaluate(() => localStorage.getItem('jobagent-theme'))).toBe('light');
      expect(await toggle.getAttribute('aria-label')).toBe('Switch to dark theme');
      // The saved choice is applied before the first paint on the next visit.
      await page.reload();
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    });
  });

  it('holds each scene while its picture plays, and ends on the finished picture', async (ctx) => {
    if (!available) return ctx.skip();
    await withExplore(async (page) => {
      const opacity = (sel) => page.locator(sel).first().evaluate((el) => Number(getComputedStyle(el).opacity));
      // Scroll to a point inside a chapter: 0 is where its sheet starts to hold, 1 where the next sheet starts to cover it.
      const seek = (id, at) => page.evaluate(([scene, p]) => {
        const section = document.getElementById(`station-${scene}`);
        const stage = section.querySelector('.ex-scene-stage');
        const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--top-h'));
        const start = section.getBoundingClientRect().top + window.scrollY - top;
        const length = section.offsetHeight - 2 * stage.offsetHeight;
        window.scrollTo({ top: start + length * p, behavior: 'instant' });
      }, [id, at]);
      const held = (id) => page.evaluate((scene) => {
        const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--top-h'));
        return Math.abs(document.querySelector(`#station-${scene} .ex-scene-stage`).getBoundingClientRect().top - top);
      }, id);

      // The entrance plays once and is then retired; a wide window holds its scenes.
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.intro), { timeout: 10_000 }).toBe('done');
      expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBe('pinned');

      // Score: the stage stays under the header while the number counts to the model's total.
      const number = page.locator('#station-score .ex-score-num');
      // It is already playing when the sheet lands (flat, once its tilt has caught up with the
      // scroll), and the sheet, not the section, carries the chapter's ground.
      await seek('score', 0);
      await expect.poll(() => held('score'), { timeout: 5_000 }).toBeLessThan(2);
      await expect.poll(async () => Number(await number.textContent()), { timeout: 5_000 }).toBeLessThan(70);
      expect(await opacity('#station-score .ex-tier')).toBe(0);
      expect(await page.locator('#station-score .ex-scene-stage').getAttribute('data-ground')).toBe('ivory');
      expect(await page.locator('#station-score').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
      // The chapter rail is out, and names the chapter in front.
      await expect.poll(() => page.locator('.ex-rail').evaluate((el) => el.classList.contains('is-on'))).toBe(true);
      await expect.poll(() => page.locator('.ex-rail-now').textContent()).toBe('Score');
      await seek('score', 0.98);
      await expect.poll(() => held('score'), { timeout: 5_000 }).toBeLessThan(2);
      await expect.poll(() => number.textContent(), { timeout: 5_000 }).toBe(String(scoreInputs(FIELDS[0].inputs).total));
      await expect.poll(() => opacity('#station-score .ex-tier'), { timeout: 5_000 }).toBe(1);
      // Only the moment that is playing is spelled out (once the scrub has caught up with the scroll).
      await expect.poll(() => page.locator('#station-score .ex-beat.is-on .ex-beat-name').textContent(), { timeout: 5_000 }).toContain('Also asked for');
      expect(await page.locator('#station-score .ex-beat.is-on').count()).toBe(1);
      // A preset chosen on the held stage is shown at once. The chips ease in at the end of the
      // scene; wait for them to come to rest, because a click on a moving target is retried with
      // a forced scroll, and scrolling is what plays the scene.
      await expect.poll(() => page.locator('#station-score .ex-score-presets').evaluate((el) => {
        const style = getComputedStyle(el);
        return Number(style.opacity) === 1 && new DOMMatrix(style.transform).m42 === 0;
      }), { timeout: 5_000 }).toBe(true);
      await page.locator('#station-score').getByRole('button', { name: 'Thin match' }).click();
      expect(Number(await number.textContent())).toBeLessThan(60);
      await page.locator('#station-score').getByRole('button', { name: 'This job' }).click();

      // The number is the sum of the reasons counted so far: part way through, it is below the
      // total and no verdict is given yet; nothing on the sheet moves as the moments change.
      const notesHeight = () => page.locator('#station-score .ex-scene-notes').evaluate((el) => Math.round(el.getBoundingClientRect().height));
      const heights = new Set();
      for (const at of [0.05, 0.2, 0.35, 0.6, 0.9]) {
        await seek('score', at);
        await page.waitForTimeout(1100);
        heights.add(await notesHeight());
        const shown = Number(await number.textContent());
        const sum = await page.locator('#station-score .ex-scorecard').evaluate((card) => {
          const total = Number(card.querySelector('.ex-score-num').dataset.total);
          return { total, adding: card.classList.contains('is-adding') };
        });
        expect(shown <= sum.total, `at ${at}: ${shown} of ${sum.total}`).toBe(true);
        expect(sum.adding, `at ${at}: a verdict only once every point is in`).toBe(shown !== sum.total);
      }
      expect(heights.size, 'the list of moments keeps its height').toBe(1);

      // Discover: three copies of one role end as one row, and every row carries its outcome.
      await seek('discover', 0.02);
      await expect.poll(() => page.locator('#station-discover .ex-board-copy').first().evaluate((el) => getComputedStyle(el).visibility), { timeout: 5_000 }).toBe('visible');
      await seek('discover', 0.99);
      await expect.poll(() => page.locator('#station-discover .ex-board-copy').first().evaluate((el) => getComputedStyle(el).visibility), { timeout: 5_000 }).toBe('hidden');
      await expect.poll(() => opacity('#station-discover .ex-board-merged > .ex-board-out'), { timeout: 5_000 }).toBe(1);

      // Tailor: the bullets settle in their new order and the terms are emphasized.
      const bullet = page.locator('#station-tailor .ex-sheet-tailored .ex-sheet-bullet').first();
      await seek('tailor', 0.99);
      await expect.poll(() => bullet.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42), { timeout: 5_000 }).toBe(0);
      await expect.poll(() => page.locator('#station-tailor .ex-sheet-tailored .ex-kw').first().evaluate((el) => getComputedStyle(el).fontWeight), { timeout: 5_000 }).toBe('760');
      // The header's rule takes the colour of the line you are on.
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.here)).toBe('apply');

      // Fill: it ends stopped before Submit, with the unanswered question left alone.
      await seek('fill', 0.99);
      await expect.poll(() => opacity('#station-fill .ex-halt'), { timeout: 5_000 }).toBe(1);
      expect(await page.locator('#station-fill .ex-field-ask .ex-field-value').count()).toBe(0);

      // Track: the application ends in the stage you confirmed.
      await seek('track', 0.99);
      await expect.poll(() => page.locator('#station-track .ex-app').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41), { timeout: 5_000 }).toBe(0);
      expect(await page.locator('#station-track .ex-stage.is-current .ex-stage-name').textContent()).toBe('Interviewing');

      // Switching pages stops the Overview's choreography; the deep dive's network draws itself in.
      await page.getByRole('button', { name: 'Under the hood' }).click();
      await page.waitForSelector('#viewHow:not([hidden])');
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.vt ?? 'none'), { timeout: 5_000 }).toBe('none');
      expect(await page.evaluate(() => document.documentElement.dataset.motion ?? 'none')).toBe('none');
      await page.evaluate(() => {
        const el = document.querySelector('#topic-system .ex-map');
        window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 120, behavior: 'instant' });
      });
      await expect.poll(() => opacity('#topic-system [data-node="sites"]'), { timeout: 6_000 }).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

      // Coming back starts it again.
      await page.getByRole('button', { name: 'Overview' }).click();
      await page.waitForSelector('#viewOverview:not([hidden])');
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.motion)).toBe('pinned');
    }, { motion: true, theme: 'light' });
  });

  it('covers every held sheet with the next one: no empty frame between chapters', async (ctx) => {
    if (!available) return ctx.skip();
    await withExplore(async (page) => {
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.motion)).toBe('pinned');
      const sheets = await page.evaluate(() => [...document.querySelectorAll('.ex-sheet-chapter, .ex-never')].map((el) => el.id));
      expect(sheets.length).toBe(JOURNEY.length + 2 + 1);
      for (let i = 0; i < sheets.length - 1; i += 1) {
        // Half way through a peel, the held sheet is still in place and the next one is over it,
        // so the window shows sheet, then sheet: never the page behind them.
        const gap = await page.evaluate(([a, b]) => {
          const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--top-h'));
          const next = document.getElementById(b);
          const y = next.getBoundingClientRect().top + window.scrollY - (top + (innerHeight - top) / 2);
          window.scrollTo({ top: y, behavior: 'instant' });
          const held = document.querySelector(`#${a} .ex-plate`).getBoundingClientRect();
          const rising = (next.querySelector('.ex-plate') ?? next).getBoundingClientRect();
          return { heldTop: Math.round(held.top - top), heldBottom: Math.round(innerHeight - held.bottom), risingTop: Math.round(rising.top) };
        }, [sheets[i], sheets[i + 1]]);
        expect(gap.heldTop, `${sheets[i]} is still held`).toBeLessThanOrEqual(2);
        expect(gap.heldBottom, `${sheets[i]} reaches the foot of the window`).toBeLessThanOrEqual(40);
        expect(gap.risingTop, `${sheets[i + 1]} is rising over it`).toBeLessThan(innerHeightOf(page));
      }
    }, { motion: true, viewport: { width: 1440, height: 900 } });
  });

  it('keeps the headline whole and the hero working after the window is resized (2026-11-16 regression)', async (ctx) => {
    if (!available) return ctx.skip();
    await withExplore(async (page, context) => {
      // CSS smooth scrolling made the scroll library measure every scene in the wrong place after a resize.
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
      await page.evaluate(() => window.scrollTo({ top: 6000, behavior: 'instant' }));
      await page.waitForTimeout(900);
      await page.setViewportSize({ width: 1997, height: 1161 });
      await page.waitForTimeout(1200);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      // Back at the top the morning of postings is in full view again, and the chapter rail is put away.
      await expect.poll(() => page.locator('.ex-fcard:not(.is-ours)').first().evaluate((el) => Number(getComputedStyle(el).opacity)), { timeout: 5_000 }).toBeGreaterThan(0.95);
      await expect.poll(() => page.locator('.ex-rail').evaluate((el) => el.classList.contains('is-on')), { timeout: 5_000 }).toBe(false);
      // The headline is never cut off by its own column, at any window width.
      for (const width of [1180, 1440, 1997, 2560]) {
        await page.setViewportSize({ width, height: 1161 });
        await page.waitForTimeout(300);
        const cut = await page.evaluate(() => [...document.querySelectorAll('.ex-hero-title .ex-line')].map((line) => {
          const range = document.createRange();
          range.selectNodeContents(line.firstElementChild);
          return Math.round(range.getBoundingClientRect().right - line.getBoundingClientRect().right);
        }));
        for (const over of cut) expect(over, `${width}px`).toBeLessThanOrEqual(1);
      }
      void context;
    }, { motion: true, theme: 'light', viewport: { width: 1440, height: 900 } });
  });

  it('holds the posting at each signal until the person presses, then lets it through', async (ctx) => {
    if (!available) return ctx.skip();
    await withExplore(async (page) => {
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.motion)).toBe('pinned');
      for (const id of ['signal-tailor', 'signal-fill']) {
        const at = (p) => page.evaluate(([sid, q]) => {
          const el = document.getElementById(sid);
          const top = el.getBoundingClientRect().top + window.scrollY;
          const start = top - innerHeight;
          const end = top + el.offsetHeight - 2 * el.querySelector('.ex-plate').offsetHeight;
          window.scrollTo({ top: start + (end - start) * q, behavior: 'instant' });
        }, [id, p]);
        const state = () => page.evaluate((sid) => {
          const plate = document.querySelector(`#${sid} .ex-plate`);
          const token = plate.querySelector('.ex-gate-token').getBoundingClientRect();
          const stop = plate.querySelector('.ex-gate-stopline').getBoundingClientRect();
          return {
            clear: Number(getComputedStyle(plate).getPropertyValue('--clear')),
            passed: token.left > stop.right,
            done: Number(getComputedStyle(plate.querySelector('.ex-gate-done')).opacity),
          };
        }, id);
        // Held: the lamp at danger, the posting short of the stop, nothing approved.
        await at(0.4);
        await page.waitForTimeout(1300);
        expect(await state(), `${id} held`).toEqual({ clear: 0, passed: false, done: 0 });
        // Pressed: the lamp clear, the posting through, and the result said.
        await at(1);
        await expect.poll(state, { timeout: 5_000 }).toEqual({ clear: 1, passed: true, done: 1 });
      }
    }, { motion: true, theme: 'light', viewport: { width: 1440, height: 900 } });
  });

  it('plays each picture once on a phone, without holding the page', async (ctx) => {
    if (!available) return ctx.skip();
    await withExplore(async (page) => {
      expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBe('flow');
      expect(await page.locator('#station-score .ex-scene-stage').evaluate((el) => getComputedStyle(el).position)).not.toBe('sticky');
      await page.evaluate(() => {
        const el = document.querySelector('#station-score .ex-scene-pic');
        window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 200, behavior: 'instant' });
      });
      await expect.poll(() => page.locator('#station-score .ex-score-num').textContent(), { timeout: 10_000 }).toBe(String(scoreInputs(FIELDS[0].inputs).total));
      // Every moment stays listed: nothing folds away where nothing holds.
      expect(await page.locator('#station-score .ex-beat-text').first().evaluate((el) => el.offsetHeight)).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    }, { motion: true, viewport: { width: 390, height: 800 } });
  });

  it('shows the finished page at once when the reader prefers reduced motion', async (ctx) => {
    if (!available) return ctx.skip();
    await withExplore(async (page) => {
      expect(await page.evaluate(() => document.documentElement.dataset.intro)).toBe('done');
      expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBe('none');
      // Nothing holds and nothing waits to be played: every picture is fully drawn before it is scrolled to.
      expect(await page.locator('.ex-scene-stage').evaluateAll((els) => els.filter((el) => getComputedStyle(el).position === 'sticky').length)).toBe(0);
      const hidden = await page.evaluate(() => [...document.querySelectorAll('.ex-demo, .ex-scene-head, .ex-beat, .ex-gate-title, .ex-board-row, .ex-board-out, .ex-field-value, .ex-halt, .ex-event, .ex-fcard, .ex-hood-node')]
        .filter((el) => Number(getComputedStyle(el).opacity) < 1 || getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).clipPath.startsWith('inset(0px 100%')).length);
      expect(hidden).toBe(0);
      expect(await page.locator('#station-score .ex-score-num').textContent()).toBe(String(scoreInputs(FIELDS[0].inputs).total));
      expect(await page.locator('#station-score .ex-scorecard').evaluate((el) => el.classList.contains('is-adding'))).toBe(false);
      // The copies that only exist while Discover plays are never shown.
      expect(await page.locator('.ex-board-copy').evaluateAll((els) => els.filter((el) => getComputedStyle(el).visibility !== 'hidden').length)).toBe(0);
    });
  });

  it('falls back to grouped rows where the network would not fit', async (ctx) => {
    if (!available) return ctx.skip();
    await withExplore(async (page) => {
      const system = page.locator('#topic-system');
      expect(await system.locator('.ex-net-svg').isVisible()).toBe(false);
      expect(await system.locator('.ex-map-group-name').first().isVisible()).toBe(true);
      await system.locator('[data-node="automation"]').click();
      expect(await system.locator('.ex-detail h3').textContent()).toBe('Browser assist');
    }, { hash: '#/how', viewport: { width: 390, height: 800 } });
  });

  for (const [name, hash] of [['Overview', ''], ['Deep dive', '#/how']]) {
    it(`fits every width without sideways scrolling: ${name}`, async (ctx) => {
      if (!available) return ctx.skip();
      for (const width of [320, 375, 414, 768, 1024]) {
        await withExplore(async (page) => {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, `${name} at ${width}px`).toBeLessThanOrEqual(0);
          // No button or call to action wraps onto a second line.
          const wrapped = await page.evaluate(() => [...document.querySelectorAll('.ex-btn, .ex-chip, .ex-flow-step, .ex-signal-btn')]
            .filter((el) => el.offsetParent && el.getClientRects().length && el.offsetHeight > 52).map((el) => el.textContent.trim()));
          expect(wrapped, `${name} at ${width}px`).toEqual([]);
        }, { hash, viewport: { width, height: 800 } });
      }
    });
  }

  for (const theme of ['dark', 'light']) {
    for (const [name, hash] of [['Overview', ''], ['Deep dive', '#/how']]) {
      for (const width of [1280, 390]) {
        it(`has no WCAG A/AA violation: ${name}, ${theme} theme, ${width}px`, async (ctx) => {
          if (!available) return ctx.skip();
          await withExplore(async (page) => {
            await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
            // Open every disclosure, so what is inside them is scanned too.
            await page.evaluate(() => { for (const d of document.querySelectorAll('details')) d.open = true; });
            if (!hash) {
              // Scan with a signal waiting (its button live) as well as at rest.
              await page.locator('.ex-route').scrollIntoViewIfNeeded();
              await expect.poll(() => page.locator('.ex-route').getAttribute('data-state'), { timeout: 15_000 }).toBe('held');
            }
            expect(await scan(page), `${name} (${theme}, ${width}px)`).toEqual([]);
          }, { hash, theme, bypassCSP: true, viewport: { width, height: 900 } });
        });
      }
    }
  }
});

/** The window's height, for a bound measured against it. */
function innerHeightOf(page) {
  return page.viewportSize()?.height ?? 900;
}

/** axe violations as compact, readable records. */
async function scan(page) {
  if (!(await page.evaluate(() => typeof window.axe !== 'undefined'))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (tags) => {
    // eslint-disable-next-line no-undef
    const result = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return result.violations.map((v) => `${v.impact} ${v.id}: ${v.help} -> ${v.nodes.slice(0, 4).map((n) => {
      const d = n.any?.[0]?.data;
      return `${n.target.join(' ')}${d?.fgColor ? ` [${d.fgColor} on ${d.bgColor} = ${d.contrastRatio}:1]` : ''}`;
    }).join(' | ')}`);
  }, TAGS);
}
