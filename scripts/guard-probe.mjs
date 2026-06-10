import { chromium } from 'playwright';
import { detectBlocker, GUARD_SIGNALS } from '../src/automation/guards.js';

const url = process.argv[2] ?? 'https://click.appcast.io/t/vMoqy8C-s7vjuIkCjNXEbv0SCccDpVq1K2puKS5QlTA=';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const status = resp?.status() ?? null;
  const finalUrl = page.url();
  const html = await page.content();
  const v = detectBlocker({ html, url: finalUrl, status });

  // Which specific tokens are present, per kind?
  const lower = `${html} ${finalUrl}`.toLowerCase();
  const present = {};
  for (const [kind, tokens] of Object.entries(GUARD_SIGNALS)) {
    const hits = tokens.filter((t) => lower.includes(t));
    if (hits.length) present[kind] = hits;
  }
  console.log(JSON.stringify({
    status, finalUrl, htmlLength: html.length,
    verdict: v, matchedTokensByKind: present,
  }, null, 2));
} catch (err) {
  console.log(JSON.stringify({ error: err.message }));
} finally {
  await browser.close();
}
