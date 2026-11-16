/**
 * Explore JobAgent: how well each chapter's picture fits its held sheet.
 *
 * In a wide window a chapter's picture is scaled down when it is taller than
 * the room its sheet has (motion.js, fitPictures). A scale much under 1 means
 * small text, so this prints, for every field and chapter at each window size:
 * the scale, the picture's natural height, the room it has, and the smallest
 * text on screen inside it.
 *
 *   node docs/explore/tools/measure.mjs [--sizes=1440x900,1180x700] [--fields=software,nursing]
 */
/* global document, getComputedStyle -- these names are used inside functions that run in the page, not in Node. */
import { launchBrowser, startTestDashboard } from '../../../tests/node/helpers/dashboardPage.js';
import { FIELDS } from '../../../src/dashboard/public/assets/explore/js/content-overview.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));
const sizes = (args.sizes ?? '1440x900,1180x700').split(',').map((s) => s.split('x').map(Number));
const fields = (args.fields ?? FIELDS.map((f) => f.id).join(',')).split(',');

const dash = await startTestDashboard();
const browser = await launchBrowser();
try {
  for (const [width, height] of sizes) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'no-preference' });
    for (const field of fields) {
      await page.goto(`${dash.url}/assets/explore/index.html#/overview?field=${field}`);
      await page.reload();
      await page.waitForSelector('html[data-ready="true"]');
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(600);
      const rows = await page.evaluate(() => [...document.querySelectorAll('.ex-scene')].map((scene) => {
        const pic = scene.querySelector('.ex-scene-pic');
        const demo = pic.querySelector('.ex-demo');
        const fit = Number(demo.style.getPropertyValue('--fit') || 1);
        let small = 99;
        for (const el of demo.querySelectorAll('*')) {
          if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
          small = Math.min(small, parseFloat(getComputedStyle(el).fontSize) * fit);
        }
        const notes = scene.querySelector('.ex-scene-notes');
        const inner = scene.querySelector('.ex-scene-inner');
        return {
          scene: scene.dataset.scene, fit, natural: demo.offsetHeight, room: pic.clientHeight, small: +small.toFixed(1),
          // Does the words column spill past the room the sheet gives it?
          spill: Math.round(notes.getBoundingClientRect().bottom - (inner.getBoundingClientRect().bottom - parseFloat(getComputedStyle(inner).paddingBottom))),
        };
      }));
      console.log(`${width}x${height} ${field.padEnd(11)} ${rows.map((r) => `${r.scene} ${r.fit.toFixed(2)} (${r.natural}/${r.room}, ${r.small}px${r.spill > 1 ? `, words +${r.spill}` : ''})`).join('  ')}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  await dash.stop();
}
