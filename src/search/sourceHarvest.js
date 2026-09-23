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

import { extractCoordinate } from './platforms.js';

/**
 * Extract the ATS coordinate a single job URL reveals.
 *
 * The recognition rules themselves live in `platforms.js`, which is the single
 * registry shared by the harvester, detection, and reporting. This function is
 * the harvester's stable entry point onto it — previously the two carried
 * duplicate copies of the same host patterns, which is exactly how one of them
 * ends up a platform behind the other.
 *
 * @param {string} url a job posting URL
 * @returns {object|null} `{ ats, ...coordinates }`, or null when the URL names
 *   no board we can enumerate
 */
export function extractAtsCoordinate(url) {
  return extractCoordinate(url);
}

/** Stable identity for a coordinate, used for dedup and config comparison. */
export function coordinateKey(coord) {
  if (!coord) return '';
  if (coord.ats === 'workday') {
    return `workday|${coord.host}|${coord.tenant}|${coord.site}`;
  }
  if (coord.ats === 'oracleRecruiting') {
    return `oracleRecruiting|${coord.host}|${coord.siteNumber}`;
  }
  // One iCIMS portal host is one employer, so the host alone is the identity.
  if (coord.ats === 'icims') return `icims|${coord.host}`;
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
  return scanConfiguredCoordinates(jobboards).keys;
}

/**
 * Coordinates listed MORE THAN ONCE inside the adapters' own board/tenant
 * lists — each one is a board fetched twice per run. `harvestSources --apply`
 * refuses to write a config that has any it did not already have.
 *
 * @param {object} jobboards
 * @returns {string[]}
 */
export function duplicateCoordinateKeys(jobboards = {}) {
  return scanConfiguredCoordinates(jobboards).duplicates;
}

/** One pass over the config: every covered key, and the adapter-list repeats. */
function scanConfiguredCoordinates(jobboards = {}) {
  const keys = new Set();
  const duplicates = new Set();
  // Only an ADAPTER list can hold a duplicate; a careers entry pinning the same
  // board as an adapter is a legitimate second route, not a double write.
  const add = (key) => {
    if (keys.has(key)) duplicates.add(key);
    keys.add(key);
  };
  for (const source of jobboards.sources ?? []) {
    const adapter = source.adapter;
    if (adapter === 'workday') {
      for (const t of source.tenants ?? []) {
        if (!t?.host || !t?.tenant || !t?.site) continue;
        add(coordinateKey({ ats: 'workday', host: t.host, tenant: t.tenant, site: t.site }));
      }
      continue;
    }
    if (adapter === 'oracleRecruiting') {
      for (const t of source.tenants ?? []) {
        if (!t?.host || !t?.siteNumber) continue;
        add(coordinateKey({ ats: 'oracleRecruiting', host: t.host, siteNumber: t.siteNumber }));
      }
      continue;
    }
    if (adapter === 'icims') {
      // Portals are configured either as a bare host string or { host, company }.
      for (const b of source.boards ?? []) {
        const host = typeof b === 'string' ? b : b?.host;
        if (host) add(coordinateKey({ ats: 'icims', host }));
      }
      continue;
    }
    // Slug-keyed boards. `rippling` belongs here and was missing: its harvested
    // boards were written to the config but never recognized as already covered,
    // so every later harvest re-proposed all of them and --apply appended a
    // second copy of each. mergeCoordinates dedupes only against THIS set, so an
    // omission here is a silent duplicate-writer, not a no-op.
    if (!['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'rippling'].includes(adapter)) continue;
    for (const board of source.boards ?? []) {
      const slug = typeof board === 'string' ? board : board?.slug;
      if (slug) add(coordinateKey({ ats: adapter, slug }));
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
  return { keys, duplicates: [...duplicates] };
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

    if (coord.ats === 'icims') {
      source.boards = source.boards ?? [];
      source.boards.push(
        coord.company ? { host: coord.host, company: coord.company } : coord.host,
      );
    } else if (coord.ats === 'oracleRecruiting') {
      source.tenants = source.tenants ?? [];
      source.tenants.push({
        host: coord.host,
        siteNumber: coord.siteNumber,
        company: coord.company ?? coord.host.split('.')[0],
        // No `keywords` on purpose — omitting the key is what makes the adapter
        // derive its phrases from candidate.targetTitles, so a harvested tenant
        // tracks the profile instead of freezing to whatever role was current
        // the day it was harvested.
      });
    } else if (coord.ats === 'workday') {
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
