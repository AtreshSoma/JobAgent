#!/usr/bin/env node
/**
 * Turn a company's careers URL into a ready-to-paste jobboards.json entry
 * (audit plan 3.2).
 *
 *   npm run resolve-careers -- https://careers.example.com
 *   npm run resolve-careers -- https://careers.example.com --verify
 *
 * One GET of the page (identifying User-Agent, no login, no bypass). Detection:
 *   1. the URL itself names a known ATS host (platforms.js);
 *   2. links inside the page point at an ATS board (Workday, Greenhouse, ...);
 *   3. body markers name the platform (iCIMS, SuccessFactors, Eightfold, ...);
 *   4. the site publishes a job sitemap (/careers/sitemap.xml, /sitemap.xml).
 * With --verify, a found Workday site is asked for one result to prove the
 * tenant/site pair answers (HTTP 422 means the site name is wrong).
 */
import { detectPlatform, extractCoordinate, platformForUrl } from '../src/search/platforms.js';
import { discoveryHeaders } from '../src/utils/httpClient.js';
import { safeFetch } from '../src/utils/safeFetch.js';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const verify = args.includes('--verify');
if (!target) {
  console.error('usage: npm run resolve-careers -- <careers URL> [--verify]');
  process.exit(2);
}

async function get(url, init = {}) {
  const res = await safeFetch(url, { ...init, headers: discoveryHeaders({ Accept: 'text/html,application/xml,application/json', ...(init.headers ?? {}) }) });
  return { status: res.status, text: await res.text() };
}

function entryFor(coord, name) {
  if (!coord) return null;
  switch (coord.ats) {
    case 'workday': return { source: 'workday-public', entry: { host: coord.host, tenant: coord.tenant, site: coord.site, company: name, pageSize: 20 } };
    case 'greenhouse': return { source: 'greenhouse-boards', entry: coord.slug };
    case 'lever': return { source: 'lever-boards', entry: coord.slug };
    case 'ashby': return { source: 'ashby-boards', entry: coord.slug };
    case 'smartrecruiters': return { source: 'smartrecruiters-companies', entry: coord.slug };
    case 'rippling': return { source: 'rippling-boards', entry: coord.slug };
    case 'oracleRecruiting': return { source: 'oracle-recruiting', entry: { host: coord.host, siteNumber: coord.siteNumber, company: name } };
    case 'icims': return { source: 'icims-portals', entry: { host: coord.host, company: name } };
    default: return null;
  }
}

async function verifyWorkday({ host, tenant, site }) {
  const res = await safeFetch(`https://${host}/wday/cxs/${tenant}/${site}/jobs`, {
    method: 'POST',
    headers: discoveryHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({ limit: 1, offset: 0, searchText: '', appliedFacets: {} }),
  });
  const body = await res.text();
  const total = /"total":(\d+)/.exec(body)?.[1];
  return res.status === 200 ? `OK, ${total ?? '?'} open postings` : `HTTP ${res.status} (site name probably wrong)`;
}

const name = new URL(target).hostname.replace(/^(www|careers|jobs|apply)\./, '').split('.')[0];
const found = [];

const direct = extractCoordinate(target);
if (direct) found.push({ via: 'url', coord: direct });

let page = null;
try {
  page = await get(target);
  console.log(`GET ${target} -> HTTP ${page.status}`);
} catch (err) {
  console.log(`GET ${target} failed: ${err.message}`);
}

if (page?.text) {
  const links = new Set([...page.text.matchAll(/https?:\/\/[^"'\s<>)]+/g)].map((m) => m[0].replace(/&amp;/g, '&')));
  for (const link of links) {
    if (!platformForUrl(link)) continue;
    const coord = extractCoordinate(link);
    if (coord && !found.some((f) => JSON.stringify(f.coord) === JSON.stringify(coord))) found.push({ via: 'link', coord, link });
  }
  if (!found.length) {
    const byBody = detectPlatform({ html: page.text });
    if (byBody) console.log(`Body markers suggest ${byBody.platform.label}${byBody.platform.enumerable ? '' : ` (not directly enumerable: ${byBody.platform.note ?? ''})`}`);
  }
}

if (!found.length) {
  const origin = new URL(target).origin;
  for (const path of ['/careers/sitemap.xml', '/sitemap.xml']) {
    try {
      const sm = await get(origin + path);
      const jobLocs = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => /\/(job|jobs|details|position)s?\//i.test(u));
      if (sm.status === 200 && jobLocs.length) {
        console.log(`\nJob sitemap: ${origin + path} (${jobLocs.length} job URLs). Check robots.txt allows it, then add to company-careers:`);
        console.log(JSON.stringify({ name, sitemap: origin + path }, null, 2));
        process.exit(0);
      }
    } catch { /* try the next */ }
  }
  console.log('\nNo ATS board, job link or job sitemap found. Use manual URLs (manual-urls) for this employer.');
  process.exit(1);
}

for (const f of found) {
  const out = entryFor(f.coord, name);
  if (!out) continue;
  console.log(`\nFound ${f.coord.ats} via ${f.via}${f.link ? ` (${f.link})` : ''}. Add to "${out.source}":`);
  console.log(JSON.stringify(out.entry, null, 2));
  if (verify && f.coord.ats === 'workday') console.log(`verify: ${await verifyWorkday(f.coord)}`);
}
