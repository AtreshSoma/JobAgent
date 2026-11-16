/**
 * Explore JobAgent: scroll recordings and a performance baseline.
 *
 * Serves the page from a private test dashboard, then scrolls the Overview with
 * real wheel events three ways (slowly, in fast flicks, and backwards) while it
 * records a video and measures, inside the page:
 *
 *   - frame intervals (requestAnimationFrame), so dropped frames can be counted;
 *   - long tasks over 50 ms (PerformanceObserver 'longtask');
 *   - layout shift (PerformanceObserver 'layout-shift', without recent input);
 *   - transferred bytes per resource type (Resource Timing).
 *
 *   node docs/explore/tools/trace.mjs --out=<dir> [--size=1440x900] [--theme=light] [--no-video]
 *
 * Headless Chromium paints at the display's refresh rate when it can; the
 * numbers are for comparing one build of the page with another on the same
 * machine, not for quoting as an absolute frame rate.
 */
/* global document, window, innerHeight, requestAnimationFrame -- these names are used inside functions that run in the page, not in Node. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { launchBrowser, startTestDashboard } from '../../../tests/node/helpers/dashboardPage.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));
const OUT = resolve(args.out ?? 'explore-trace');
const [width, height] = (args.size ?? '1440x900').split('x').map(Number);
const theme = args.theme ?? 'light';
const PAGE = '/assets/explore/index.html';

const PASSES = [
  { name: 'slow', step: 10, every: 16, direction: 1 },
  { name: 'fast', step: 900, every: 220, direction: 1 },
  { name: 'back', step: 400, every: 60, direction: -1 },
];

function instrument() {
  const m = { frames: [], long: [], shift: 0, shifts: 0 };
  globalThis.__m = m;
  let last = performance.now();
  const tick = (now) => { m.frames.push(now - last); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) m.long.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch { /* not supported */ }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) { m.shift += e.value; m.shifts += 1; }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* not supported */ }
}

const reset = () => { const m = globalThis.__m; m.frames.length = 0; m.long.length = 0; m.shift = 0; m.shifts = 0; };

function read() {
  const m = globalThis.__m;
  const frames = m.frames.slice(2);
  const sorted = [...frames].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  const total = frames.reduce((s, f) => s + f, 0);
  // The frame budget is taken from the median interval, so a 120 Hz display is not judged at 60.
  const budget = at(0.5);
  return {
    frames: frames.length,
    seconds: +(total / 1000).toFixed(2),
    fps: +(frames.length / (total / 1000)).toFixed(1),
    medianMs: +budget.toFixed(2),
    p95Ms: +at(0.95).toFixed(2),
    p99Ms: +at(0.99).toFixed(2),
    worstMs: +(sorted[sorted.length - 1] ?? 0).toFixed(1),
    dropped: frames.filter((f) => f > budget * 1.5).length,
    over50ms: frames.filter((f) => f > 50).length,
    longTasks: m.long.length,
    longestTaskMs: Math.max(0, ...m.long),
    layoutShift: +m.shift.toFixed(4),
    layoutShifts: m.shifts,
  };
}

const dash = await startTestDashboard();
const browser = await launchBrowser();
mkdirSync(OUT, { recursive: true });
const report = { size: `${width}x${height}`, theme, passes: {} };
try {
  for (const pass of PASSES) {
    const context = await browser.newContext({
      viewport: { width, height }, colorScheme: theme, reducedMotion: 'no-preference', deviceScaleFactor: 1,
      ...(args['no-video'] ? {} : { recordVideo: { dir: join(OUT, pass.name), size: { width, height } } }),
    });
    await context.addInitScript(instrument);
    const page = await context.newPage();
    await page.goto(`${dash.url}${PAGE}#/overview`);
    await page.waitForSelector('html[data-ready="true"]');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(2500);
    if (pass.name === 'slow') {
      report.load = await page.evaluate(() => ({ ...(() => { const m = globalThis.__m; return { layoutShift: +m.shift.toFixed(4), longTasks: [...m.long] }; })(), mode: document.documentElement.dataset.motion }));
      report.weight = await page.evaluate(() => {
        const by = {};
        for (const r of performance.getEntriesByType('resource')) {
          const kind = r.initiatorType === 'css' && /\.woff2/.test(r.name) ? 'font' : /\.woff2/.test(r.name) ? 'font' : /\.css/.test(r.name) ? 'css' : /\.js/.test(r.name) ? 'js' : 'other';
          by[kind] = by[kind] ?? { files: 0, bytes: 0 };
          by[kind].files += 1;
          by[kind].bytes += r.decodedBodySize || r.transferSize || 0;
        }
        return by;
      });
    }
    const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    if (pass.direction < 0) {
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), max);
      await page.waitForTimeout(1500);
    }
    await page.mouse.move(width / 2, height / 2);
    await page.evaluate(reset);
    const steps = Math.ceil(max / pass.step);
    for (let i = 0; i < steps; i += 1) {
      await page.mouse.wheel(0, pass.step * pass.direction);
      await page.waitForTimeout(pass.every);
    }
    await page.waitForTimeout(1200);
    report.passes[pass.name] = { pageHeight: max + height, ...(await page.evaluate(read)) };
    await context.close();
  }
  writeFileSync(join(OUT, 'trace.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await dash.stop();
}
