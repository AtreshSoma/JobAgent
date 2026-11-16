/**
 * Explore JobAgent: the Score and Tailor chapters, photographed for every field.
 *
 *   node docs/explore/tools/fields.mjs --out=docs/explore/after/fields [--width=1440]
 *
 * Reduced motion, so each picture is its finished state, and each chapter is
 * photographed on its own.
 */
/* global document */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { launchBrowser, startTestDashboard } from '../../../tests/node/helpers/dashboardPage.js';
import { FIELDS } from '../../../src/dashboard/public/assets/explore/js/content-overview.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const OUT = resolve(args.out ?? 'explore-fields');
mkdirSync(OUT, { recursive: true });
const dash = await startTestDashboard();
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: Number(args.width ?? 1440), height: 900 }, reducedMotion: 'reduce' });
  for (const field of FIELDS) {
    await page.goto(`${dash.url}/assets/explore/index.html#/overview?field=${field.id}`);
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await page.evaluate(() => document.fonts.ready);
    // A capture taller than the window would paint the sticky header across the middle of the picture.
    await page.addStyleTag({ content: '.ex-top, .ex-rail { visibility: hidden !important; }' });
    for (const chapter of ['score', 'tailor']) {
      const plate = page.locator(`#station-${chapter} .ex-plate`);
      await plate.scrollIntoViewIfNeeded();
      await plate.screenshot({ path: join(OUT, `${chapter}-${field.id}.jpg`), type: 'jpeg', quality: 78 });
    }
  }
} finally {
  await browser.close();
  await dash.stop();
}
