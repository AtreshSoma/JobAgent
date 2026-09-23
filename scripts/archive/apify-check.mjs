/**
 * Apify diagnostic — verifies the token and checks actor access.
 * Prints ONLY status codes and safe metadata. Never prints the token.
 */
import dotenv from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env'), quiet: true });

const token = process.env.APIFY_TOKEN;
if (!token) {
  console.log('NO TOKEN: APIFY_TOKEN is not set in .env');
  process.exit(0);
}
console.log(`Token present: yes (length ${token.length}, starts "${token.slice(0, 6)}…")`);

const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

// 1. Is the token valid?
const me = await fetch('https://api.apify.com/v2/users/me', { headers: h });
console.log(`/users/me -> HTTP ${me.status} ${me.status === 200 ? '(token VALID)' : '(token problem)'}`);
if (me.status === 200) {
  const data = await me.json();
  console.log(`  account: ${data?.data?.username ?? 'unknown'} | plan: ${data?.data?.plan?.id ?? 'free'}`);
}

// 2. Can we access the configured actor?
const actorId = process.argv[2] ?? 'bebity~linkedin-jobs-scraper';
const act = await fetch(`https://api.apify.com/v2/acts/${actorId}`, { headers: h });
console.log(`/acts/${actorId} -> HTTP ${act.status}`);
if (act.status === 200) {
  const data = await act.json();
  const d = data?.data ?? {};
  console.log(`  title: ${d.title ?? d.name}`);
  console.log(`  isPublic: ${d.isPublic} | rentable: ${Boolean(d.isPaid || d.pricingInfos?.length)}`);
} else if (act.status === 403) {
  console.log('  403 = actor exists but your account is not authorized to run it (likely a paid/rental actor you must add/rent first).');
} else if (act.status === 404) {
  console.log('  404 = no actor with that id (check the username~actor-name spelling).');
}
