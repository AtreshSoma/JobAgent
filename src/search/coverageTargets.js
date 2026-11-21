/**
 * Coverage targets: the employers the search is expected to reach, and how
 * (audit 2026-11-20, plan phase 0).
 *
 * config/coverage_targets.json lists each employer with the route that reaches
 * it (`workday`, `sitemap`, `ashby`, ...) or `unreachable`/`manual` plus the
 * reason. This module answers two questions about that list, purely:
 *
 *   isConfigured(target, jobboards)  does any enabled source name this employer?
 *   matchesCompany(target, company)  is a stored row's company this employer?
 *
 * Matching is by normalized words, anchored at the start: "Amazon.com Services
 * LLC" matches alias "amazon", but "University of California - San Francisco"
 * does not match "cisco" (it did with a plain substring test, which is how the
 * audit first over-counted Cisco).
 */

import { companyKey } from './sourceCoverage.js';

/** Routes that mean "no automated route; expected to stay empty". */
export const NON_ROUTES = new Set(['unreachable', 'manual']);

/** All match keys for a target: its name, aliases and explicit config ids. */
export function targetKeys(target) {
  return [target?.name, ...(target?.aliases ?? [])].map(companyKey).filter(Boolean);
}

/** Does a company string belong to this target? */
export function matchesCompany(target, company) {
  const key = companyKey(company);
  if (!key) return false;
  return targetKeys(target).some((k) => key === k || key.startsWith(`${k} `));
}

/** Every employer identifier an ENABLED source carries, normalized. */
export function configuredIdentifiers(jobboards) {
  const out = [];
  for (const source of jobboards?.sources ?? []) {
    if (!source?.enabled) continue;
    const lists = [source.boards, source.tenants, source.companies, source.urls].filter(Array.isArray);
    for (const list of lists) {
      for (const item of list) {
        if (typeof item === 'string') { out.push({ source: source.id, key: companyKey(item) }); continue; }
        if (!item || typeof item !== 'object') continue;
        for (const field of ['company', 'name', 'slug', 'tenant']) {
          if (item[field]) out.push({ source: source.id, key: companyKey(item[field]) });
        }
      }
    }
    // Single-employer adapters.
    if (source.adapter === 'amazonJobs') out.push({ source: source.id, key: 'amazon' });
  }
  return out.filter((x) => x.key);
}

/**
 * Is the target configured in an enabled source? Explicit `configKeys` in the
 * target (a Workday tenant id, a board slug) are matched exactly; names and
 * aliases with the same anchored rule as company names.
 *
 * @returns {string[]} ids of the sources that carry it (empty when none)
 */
export function configuredIn(target, jobboards, identifiers = configuredIdentifiers(jobboards)) {
  const exact = new Set((target?.configKeys ?? []).map(companyKey));
  const keys = targetKeys(target);
  const hits = new Set();
  for (const { source, key } of identifiers) {
    if (exact.has(key) || keys.some((k) => key === k || key.startsWith(`${k} `))) hits.add(source);
  }
  return [...hits];
}

/**
 * Configured employers that a COMPLETE source listing returned nothing for
 * this run (audit D8). A source reports "ok" with zero jobs for one employer
 * as readily as for none, so a broken tenant, a renamed board or a site name
 * Workday now rejects stayed invisible.
 *
 * Zero is not always a fault: an employer with no open role matching the
 * profile's search terms also returns nothing. The dashboard says so.
 *
 * @param {object} args
 * @param {object[]} args.targets coverage_targets.json `targets`
 * @param {object} args.jobboards
 * @param {object[]} args.perSource the run's per-source outcomes
 * @param {Iterable<string>} args.companies company of every posting the run returned
 * @returns {Array<{name: string, sources: string[]}>}
 */
export function zeroYieldTargets({ targets = [], jobboards, perSource = [], companies = [] }) {
  const complete = new Set(perSource
    .filter((s) => s?.succeeded === true && s.cancelled !== true && s.cached !== true)
    .map((s) => s.source));
  const seen = [...new Set([...companies].map((c) => String(c ?? '')))].filter(Boolean);
  const identifiers = configuredIdentifiers(jobboards);
  const out = [];
  for (const target of targets) {
    if (NON_ROUTES.has(target?.route)) continue;
    const sources = configuredIn(target, jobboards, identifiers).filter((s) => complete.has(s));
    if (!sources.length) continue;
    if (seen.some((c) => matchesCompany(target, c))) continue;
    out.push({ name: target.name, sources });
  }
  return out;
}
