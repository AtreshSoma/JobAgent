/**
 * Adzuna diagnostic — verifies the App ID/Key and runs the REAL adapter
 * against the live API for one query, so the field mapping is finally
 * exercised against a real response instead of just fixtures.
 * Prints ONLY status codes and safe metadata. Never prints the key.
 */
import dotenv from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const { run, buildSearchUrl, stripQuery } = await import('../src/search/adapters/adzuna.js');

const appId = process.env.ADZUNA_APP_ID;
const appKey = process.env.ADZUNA_APP_KEY;

if (!appId || !appKey) {
  console.log('NO CREDENTIALS: ADZUNA_APP_ID and/or ADZUNA_APP_KEY are not set in .env');
  process.exit(0);
}
console.log(`App ID present:  yes (length ${appId.length})`);
console.log(`App Key present: yes (length ${appKey.length})`);
console.log();

// 1. Are the credentials valid? A tiny direct call, one page, one query.
const url = buildSearchUrl({
  country: 'us', page: 1, appId, appKey, query: 'data engineer', where: 'United States', perPage: 5,
});
const res = await fetch(url);
console.log(`GET ${stripQuery(url)}`);
console.log(`  -> HTTP ${res.status} ${res.status === 200 ? '(credentials VALID)' : '(credentials problem)'}`);
if (res.status === 401) console.log('  401 = App ID/Key are wrong or not yet activated (activation can take a few minutes after signup).');
if (res.status === 403) console.log('  403 = check your Adzuna account is confirmed/active.');
if (res.status !== 200) process.exit(1);

const raw = await res.json();
console.log(`  server reports ${raw.count ?? '?'} total matches, ${raw.results?.length ?? 0} returned on this page`);
console.log();

// 2. Run the REAL adapter (not a hand-rolled call) so the mapping gets its
// first live exercise. This is what makes it safe to flip enabled:true.
console.log('Running the adzuna adapter for real (candidate.targetTitles, 1 page)...');
const { jobs, errors } = await run(
  { options: { maxPages: 1, resultsPerPage: 10 } },
  { env: process.env, candidate: { targetTitles: ['Data Engineer'] }, maxRetries: 1 },
);
console.log(`  jobs mapped: ${jobs.length} | errors: ${errors.length}`);
if (errors.length) console.log('  errors:', JSON.stringify(errors.slice(0, 3), null, 2));

if (jobs[0]) {
  const j = jobs[0];
  console.log();
  console.log('Sample mapped job (verify these look right before enabling):');
  console.log(`  company:  ${j.company}`);
  console.log(`  title:    ${j.title}`);
  console.log(`  location: ${j.location}`);
  console.log(`  postedAt: ${j.postedAt}`);
  console.log(`  url:      ${j.url}`);
  console.log(`  jdText:   ${(j.jdText ?? '').slice(0, 120)}...`);
  console.log(`  summaryOnly: ${j.rawMetadata?.summaryOnly}`);
}

console.log();
console.log(jobs.length > 0 && errors.length === 0
  ? 'LOOKS GOOD — set "adzuna-aggregator" -> "enabled": true in config/jobboards.json.'
  : 'Something looks off above — do not enable yet, investigate first.');
