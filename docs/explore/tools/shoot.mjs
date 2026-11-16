/**
 * Explore JobAgent: the screenshot matrix.
 *
 * Serves the page from a private test dashboard (the real server and its real
 * Content-Security-Policy, on a throwaway workspace, so no personal data is
 * read) and photographs every section of both views at each window size, in
 * both themes, with motion on and with reduced motion.
 *
 *   node docs/explore/tools/shoot.mjs --out=<dir> [--only=1440x900] [--themes=light,dark]
 *        [--sizes=1997x1161,...] [--motion=on,reduce] [--views=overview,how] [--query=field=security] [--sheets] [--sheets-only]
 *
 * Each configuration gets a folder of numbered JPEGs and, with --sheets, contact
 * sheets (several frames on one image) for reviewing many frames at once.
 */
/* global document, window, innerHeight, scrollY, getComputedStyle -- these names are used inside functions that run in the page, not in Node. */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { launchBrowser, startTestDashboard } from '../../../tests/node/helpers/dashboardPage.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));
const OUT = resolve(args.out ?? 'explore-shots');
const SIZES = (args.sizes ? args.sizes.split(',').map((s) => s.split('x').map(Number)) : [[1440, 900], [1180, 700], [768, 1024], [390, 844], [320, 568]])
  .filter(([w, h]) => !args.only || args.only.split(',').includes(`${w}x${h}`));
const THEMES = (args.themes ?? 'light,dark').split(',');
const MOTION = (args.motion ?? 'on,reduce').split(',');
const VIEWS = (args.views ?? 'overview,how').split(',');
const QUERY = args.query ? `?${args.query}` : '';
const PAGE = '/assets/explore/index.html';
const MAX_PER_SECTION = Number(args.max ?? 7);

/** Wait until no GSAP tween is running (a scrub has caught up, a reveal has finished). */
async function settle(page, { min = 350, max = 6500 } = {}) {
  await page.waitForTimeout(min);
  const started = Date.now();
  let quiet = 0;
  while (Date.now() - started < max) {
    const busy = await page.evaluate(() => {
      const g = globalThis.gsap;
      if (!g) return false;
      return g.globalTimeline.getChildren(true, true, true).some((t) => t.isActive() && t.duration() > 0);
    });
    quiet = busy ? 0 : quiet + 1;
    if (quiet >= 2) return;
    await page.waitForTimeout(150);
  }
}

/** The scroll positions that show a view: each section's top, then steps through anything taller than the window. */
function plan(page, viewId) {
  return page.evaluate(({ viewId, cap }) => {
    const view = document.getElementById(viewId);
    const top = document.querySelector('.ex-top')?.offsetHeight ?? 0;
    const vh = innerHeight;
    const blocks = [...view.children].filter((el) => el.offsetHeight > 0 && getComputedStyle(el).position !== 'fixed');
    // The How view is one article of topics: take its sections instead of the wrapper.
    const sections = blocks.flatMap((el) => {
      const inner = [...el.querySelectorAll(':scope > section, :scope > div > section, :scope > article > section')];
      return inner.length > 2 ? inner : [el];
    });
    const shots = [];
    const maxY = document.documentElement.scrollHeight - vh;
    sections.forEach((el, i) => {
      const box = el.getBoundingClientRect();
      const start = Math.max(0, Math.round(box.top + scrollY - top));
      const end = Math.min(maxY, Math.round(box.bottom + scrollY - vh));
      const name = el.id || [...el.classList].find((c) => c.startsWith('ex-') && c !== 'ex-chapter') || `block${i}`;
      const ys = [start];
      const plate = el.classList.contains('ex-sheet-chapter') && document.documentElement.dataset.motion === 'pinned' ? el.querySelector('.ex-plate') : null;
      if (plate) {
        // A held sheet: as it lands, half way through its picture, and finished, just before the next sheet rises.
        const length = el.offsetHeight - 2 * plate.offsetHeight;
        ys.length = 0;
        for (const p of [0.03, 0.5, 0.985]) ys.push(Math.round(start + length * p));
      } else if (end > start + 40) {
        const n = Math.min(cap - 1, Math.ceil((end - start) / (vh * 0.9)));
        for (let k = 1; k <= n; k += 1) ys.push(Math.round(start + ((end - start) * k) / n));
      }
      ys.forEach((y, k) => shots.push({ y: Math.min(maxY, y), name, k }));
    });
    return shots;
  }, { viewId, cap: MAX_PER_SECTION });
}

async function shootConfig(browser, url, [width, height], theme, motion) {
  const context = await browser.newContext({
    viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1,
    reducedMotion: motion === 'on' ? 'no-preference' : 'reduce',
    hasTouch: width < 800, isMobile: width < 500,
  });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
  const summary = [];
  for (const view of VIEWS) {
    const dir = join(OUT, view, `${width}x${height}-${theme}-${motion}`);
    mkdirSync(dir, { recursive: true });
    await page.goto(`${url}${PAGE}${QUERY}#/${view}`);
    await page.waitForSelector('html[data-ready="true"]');
    await page.evaluate(() => document.fonts.ready);
    await settle(page, { min: 1800 });
    const shots = await plan(page, view === 'overview' ? 'viewOverview' : 'viewHow');
    let n = 0;
    for (const shot of shots) {
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), shot.y);
      await settle(page);
      n += 1;
      const file = `${String(n).padStart(2, '0')}-${shot.name}-${shot.k}.jpg`;
      await page.screenshot({ path: join(dir, file), type: 'jpeg', quality: 84 });
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    summary.push({ view, size: `${width}x${height}`, theme, motion, mode: await page.evaluate(() => document.documentElement.dataset.motion ?? ''), frames: n, overflow, problems: [...problems] });
    problems.length = 0;
  }
  await context.close();
  return summary;
}

/** Contact sheets: the frames of one configuration, several to an image, each with its file name. */
async function contactSheets(browser) {
  const page = await browser.newPage({ viewport: { width: 1560, height: 1000 }, deviceScaleFactor: 1 });
  for (const view of readdirSync(OUT)) {
    if (!VIEWS.includes(view)) continue;
    for (const config of readdirSync(join(OUT, view))) {
      const dir = join(OUT, view, config);
      const files = readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
      if (!files.length) continue;
      const width = Number(config.split('x')[0]);
      const cols = width >= 1100 ? 3 : width >= 700 ? 4 : 6;
      const perSheet = cols * (width >= 1100 ? 3 : 1);
      const sheetDir = join(OUT, 'sheets', view);
      mkdirSync(sheetDir, { recursive: true });
      for (let i = 0; i < files.length; i += perSheet) {
        const group = files.slice(i, i + perSheet);
        const cells = group.map((f) => `<figure><img src="${pathToFileURL(join(dir, f)).href}"><figcaption>${f.replace('.jpg', '')}</figcaption></figure>`).join('');
        const sheetHtml = join(sheetDir, '_sheet.html');
        writeFileSync(sheetHtml, `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#777;font:11px/1.2 ui-monospace,monospace;color:#fff}
          .g{display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;padding:6px}figure{margin:0}img{width:100%;display:block}
          figcaption{padding:2px 0 0;white-space:nowrap;overflow:hidden}h1{font:12px ui-monospace,monospace;margin:0;padding:4px 6px 0}</style>
          <h1>${view} · ${config} · ${i + 1}-${i + group.length} of ${files.length}</h1><div class="g">${cells}</div>`);
        await page.goto(pathToFileURL(sheetHtml).href);
        await page.waitForFunction(() => [...document.images].every((img) => img.complete && img.naturalWidth > 0));
        await page.screenshot({ path: join(sheetDir, `${config}-${String(i / perSheet + 1).padStart(2, '0')}.jpg`), type: 'jpeg', quality: 80, fullPage: true });
      }
    }
  }
  await page.close();
}

if (args['sheets-only']) {
  const only = await launchBrowser();
  await contactSheets(only);
  await only.close();
  process.exit(0);
}

const dash = await startTestDashboard();
const browser = await launchBrowser();
try {
  const jobs = [];
  for (const size of SIZES) for (const theme of THEMES) for (const motion of MOTION) jobs.push([size, theme, motion]);
  const results = [];
  const workers = Array.from({ length: Number(args.parallel ?? 4) }, async () => {
    while (jobs.length) {
      const [size, theme, motion] = jobs.shift();
      results.push(...await shootConfig(browser, dash.url, size, theme, motion));
    }
  });
  await Promise.all(workers);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify(results, null, 2)}\n`);
  if (args.sheets) await contactSheets(browser);
  const bad = results.filter((r) => r.overflow > 0 || r.problems.length);
  console.log(`${results.reduce((n, r) => n + r.frames, 0)} frames in ${results.length} configurations -> ${OUT}`);
  for (const r of bad) console.log(`  ! ${r.view} ${r.size} ${r.theme} ${r.motion}: overflow ${r.overflow}px, ${r.problems.length} console problems`);
} finally {
  await browser.close();
  await dash.stop();
}
