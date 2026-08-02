/**
 * ATS coordinate harvesting.
 *
 * Turns job URLs you have ALREADY seen into permanently configured discovery
 * coverage. Every posting URL an aggregator or cross-company search hands us
 * quietly names the ATS board it came from — `jobs.lever.co/acme/...` says
 * "acme has a Lever board", `acme.wd5.myworkdayjobs.com/en-US/Careers/job/...`
 * names a Workday tenant AND its public site. Those coordinates are exactly
 * what the company-first adapters need, and until now every one of them was
 * thrown away after a single run.
 *
 * The leverage is large and measurable. When this was written the config listed
 * 14 Workday tenants while the local database already contained URLs naming 222
 * distinct Workday hosts — a 16x expansion sitting unused in data we had paid
 * Apify to fetch. Board enumeration is free and unmetered forever after, so
 * harvesting converts a one-off metered lookup into permanent free capacity.
 *
 * This module is PURE: parsing and merging only, no I/O. Liveness validation and
 * config writing live in scripts/harvestSources.mjs so this stays trivially
 * testable.
 */

/** Locale path segments to skip when locating a Workday site name. */
const LOCALE_RE = /^[a-z]{2}(-[A-Za-z]{2})?$/;

/**
 * Path segments that are never a company slug. Without this, URLs like
 * `jobs.lever.co/search` would be harvested as a company named "search".
 */
const NON_SLUG_SEGMENTS = new Set([
  'search', 'jobs', 'job', 'careers', 'career', 'embed', 'api', 'static',
  'assets', 'about', 'login', 'signin', 'apply', 'company', 'companies',
  'view', 'privacy', 'terms', 'sitemap', 'index',
]);

/**
 * Extract the ATS coordinate a single job URL reveals.
 *
 * @param {string} url a job posting URL
 * @returns {object|null} `{ ats, ...coordinates }`, or null when the URL names
 *   no board we can enumerate
 */
export function extractAtsCoordinate(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? '').trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);

  // Greenhouse: boards.greenhouse.io/<slug>, job-boards.greenhouse.io/<slug>,
  // and the embed form boards.greenhouse.io/embed/job_app?for=<slug>.
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const embedFor = parsed.searchParams.get('for');
    if (embedFor) return slugCoordinate('greenhouse', embedFor);
    return slugCoordinate('greenhouse', segments[0]);
  }

  // Lever: jobs.lever.co/<slug>/<posting-id>
  if (/(^|\.)lever\.co$/.test(host)) return slugCoordinate('lever', segments[0]);

  // Ashby: jobs.ashbyhq.com/<slug>/<posting-id>
  if (/(^|\.)ashbyhq\.com$/.test(host)) return slugCoordinate('ashby', segments[0]);

  // SmartRecruiters: jobs.smartrecruiters.com/<CompanyIdentifier>/<posting-id>
  if (/(^|\.)smartrecruiters\.com$/.test(host)) {
    // The API host carries the identifier one level deeper:
    // api.smartrecruiters.com/v1/companies/<id>/postings/<id>
    if (host.startsWith('api.')) {
      const i = segments.indexOf('companies');
      return i === -1 ? null : slugCoordinate('smartrecruiters', segments[i + 1]);
    }
    return slugCoordinate('smartrecruiters', segments[0]);
  }

  // Workable public board: apply.workable.com/<account>/j/<id>
  if (/(^|\.)workable\.com$/.test(host) && host.startsWith('apply.')) {
    return slugCoordinate('workable', segments[0]);
  }

  // Workday: <tenant>.wdNN.myworkdayjobs.com/[<locale>/]<site>/job/<...>
  if (/\.myworkdayjobs\.com$/.test(host)) return workdayCoordinate(host, segments);

  return null;
}

/** Build a `{ ats, slug }` coordinate, rejecting non-slug path segments. */
function slugCoordinate(ats, raw) {
  const slug = String(raw ?? '').trim();
  if (!slug || NON_SLUG_SEGMENTS.has(slug.toLowerCase())) return null;
  // A slug is a single path segment; anything with a dot is a filename.
  if (slug.includes('.')) return null;
  return { ats, slug };
}

/**
 * Derive `{ host, tenant, site }` from a Workday posting URL.
 *
 * The site name is the segment immediately before `/job/`, which is the only
 * position Workday guarantees. Falling back to "last segment" would harvest the
 * job title as a site name, so a URL with no `/job/` marker is skipped rather
 * than guessed at.
 */
function workdayCoordinate(host, segments) {
  const tenant = host.split('.')[0];
  if (!tenant) return null;

  const jobIndex = segments.indexOf('job');
  let site = null;
  if (jobIndex > 0) {
    site = segments[jobIndex - 1];
  } else if (segments.length === 1 && !LOCALE_RE.test(segments[0])) {
    // Bare board URL: <host>/<site>
    site = segments[0];
  } else if (segments.length === 2 && LOCALE_RE.test(segments[0])) {
    site = segments[1];
  }

  if (!site || LOCALE_RE.test(site) || NON_SLUG_SEGMENTS.has(site.toLowerCase())) return null;
  return { ats: 'workday', host, tenant, site };
}

/** Stable identity for a coordinate, used for dedup and config comparison. */
export function coordinateKey(coord) {
  if (!coord) return '';
  if (coord.ats === 'workday') {
    return `workday|${coord.host}|${coord.tenant}|${coord.site}`;
  }
  // Board slugs are compared case-insensitively; SmartRecruiters identifiers are
  // mixed-case ("McDonaldsCorporation") but always unique when lowercased.
  return `${coord.ats}|${String(coord.slug).toLowerCase()}`;
}

/**
 * Harvest coordinates from a set of `{ url, company }` rows.
 *
 * @param {Array<{url?: string, company?: string}>} rows
 * @returns {Map<string, {coord: object, count: number, companies: Set<string>}>}
 */
export function harvestCoordinates(rows = []) {
  const found = new Map();
  for (const row of rows) {
    const coord = extractAtsCoordinate(row?.url);
    if (!coord) continue;
    const key = coordinateKey(coord);
    if (!key) continue;
    let entry = found.get(key);
    if (!entry) {
      entry = { coord, count: 0, companies: new Set() };
      found.set(key, entry);
    }
    entry.count += 1;
    const company = String(row?.company ?? '').trim();
    if (company) entry.companies.add(company);
  }
  return found;
}

/**
 * List the coordinate keys a jobboards config already covers.
 *
 * @param {object} jobboards parsed config/jobboards.json
 * @returns {Set<string>}
 */
export function configuredCoordinateKeys(jobboards = {}) {
  const keys = new Set();
  for (const source of jobboards.sources ?? []) {
    const adapter = source.adapter;
    if (adapter === 'workday') {
      for (const t of source.tenants ?? []) {
        if (!t?.host || !t?.tenant || !t?.site) continue;
        keys.add(coordinateKey({ ats: 'workday', host: t.host, tenant: t.tenant, site: t.site }));
      }
      continue;
    }
    if (!['greenhouse', 'lever', 'ashby', 'smartrecruiters'].includes(adapter)) continue;
    for (const slug of source.boards ?? []) {
      keys.add(coordinateKey({ ats: adapter, slug }));
    }
  }
  // Careers-page entries can also pin an ATS coordinate.
  for (const source of jobboards.sources ?? []) {
    if (source.adapter !== 'careers') continue;
    for (const c of source.companies ?? []) {
      if (!c?.ats) continue;
      if (c.ats === 'workday' && c.host && c.site) {
        keys.add(coordinateKey({
          ats: 'workday', host: c.host, tenant: c.tenant ?? c.slug, site: c.site,
        }));
      } else if (c.slug) {
        keys.add(coordinateKey({ ats: c.ats, slug: c.slug }));
      }
    }
  }
  return keys;
}

/**
 * Merge validated coordinates into a jobboards config object.
 *
 * Returns a NEW config; the input is never mutated. Only appends — an existing
 * board list is never reordered or pruned, because a slug that returns nothing
 * today may simply have no openings today, and silently dropping it would be a
 * different (and unrequested) decision from adding new ones.
 *
 * @param {object} jobboards parsed config
 * @param {object[]} coords validated coordinates to add
 * @returns {{ config: object, added: Record<string, number>, skipped: number }}
 */
export function mergeCoordinates(jobboards, coords = []) {
  const config = JSON.parse(JSON.stringify(jobboards));
  const existing = configuredCoordinateKeys(config);
  const added = {};
  let skipped = 0;

  const sourceFor = (adapter) => config.sources.find((s) => s.adapter === adapter);

  for (const coord of coords) {
    const key = coordinateKey(coord);
    if (!key || existing.has(key)) { skipped += 1; continue; }

    const source = sourceFor(coord.ats);
    if (!source) { skipped += 1; continue; }

    if (coord.ats === 'workday') {
      source.tenants = source.tenants ?? [];
      source.tenants.push({
        host: coord.host,
        tenant: coord.tenant,
        site: coord.site,
        company: coord.company ?? coord.tenant,
        // No `searchText` on purpose. Omitting the key is what makes the
        // adapter derive its phrases from candidate.targetTitles, so a
        // harvested tenant tracks the profile automatically. Writing a literal
        // here would freeze every new board to whatever role was current the
        // day it was harvested. Pass coord.searchText only to pin one
        // deliberately.
        ...(coord.searchText === undefined ? {} : { searchText: coord.searchText }),
        pageSize: 20,
      });
    } else {
      source.boards = source.boards ?? [];
      source.boards.push(coord.slug);
    }
    existing.add(key);
    added[coord.ats] = (added[coord.ats] ?? 0) + 1;
  }

  return { config, added, skipped };
}
