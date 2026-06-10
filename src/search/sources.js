/**
 * Source-type registry.
 *
 * Draws a hard, machine-readable line between three kinds of sources so the rest
 * of the system can never conflate "real discovery" with "URL reader":
 *
 *   - 'discovery'  : enumerates many jobs from a public board/endpoint on its own
 *                    (Greenhouse, Lever, Workday CXS, company careers pages).
 *   - 'url-reader' : only parses the specific public posting URLs the user gives
 *                    it. It performs NO query/search and finds nothing on its own
 *                    (Dice, LinkedIn, Indeed, generic public pages).
 *   - 'manual'     : the fully-compliant manual fallback (curated URLs + CSV).
 *
 * This module is pure data + tiny lookups. It is the single source of truth for
 * "is this real discovery?" used by config validation, the orchestrator, and the
 * found_jobs.json report.
 */

/** Adapter ids that genuinely enumerate jobs from a public source. */
export const DISCOVERY_ADAPTERS = Object.freeze(new Set([
  'greenhouse',
  'lever',
  'workday',
  'careers',
  'apify',
  'ashby',
  'smartrecruiters',
]));

/** Adapter ids that only read user-supplied public posting URLs (no search). */
export const URL_READER_ADAPTERS = Object.freeze(new Set([
  'dice',
  'linkedin',
  'indeed',
  'genericPublicPage',
]));

/** The compliant manual fallback (curated URLs + CSV import). */
export const MANUAL_ADAPTERS = Object.freeze(new Set([
  'manualUrls',
]));

/**
 * Classify a configured source by its adapter id.
 * @param {string} adapter adapter id from jobboards.json
 * @returns {'discovery'|'url-reader'|'manual'|'unknown'}
 */
export function adapterKind(adapter) {
  if (DISCOVERY_ADAPTERS.has(adapter)) return 'discovery';
  if (URL_READER_ADAPTERS.has(adapter)) return 'url-reader';
  if (MANUAL_ADAPTERS.has(adapter)) return 'manual';
  return 'unknown';
}

/**
 * The `source` string a normalized job carries can differ from the adapter id
 * (e.g. a careers page that delegates to Greenhouse still emits source
 * 'greenhouse'; a generic page emits 'public'). Map those to a kind too so the
 * found_jobs.json report can summarize provenance accurately.
 */
const SOURCE_STRING_KIND = Object.freeze({
  greenhouse: 'discovery',
  lever: 'discovery',
  workday: 'discovery',
  careers: 'discovery',
  apify: 'discovery',
  ashby: 'discovery',
  smartrecruiters: 'discovery',
  dice: 'url-reader',
  linkedin: 'url-reader',
  indeed: 'url-reader',
  public: 'url-reader',
  generic: 'url-reader',
  manual: 'manual',
});

/**
 * Classify a normalized job's `source` string.
 * @param {string} sourceString job.source
 * @returns {'discovery'|'url-reader'|'manual'|'unknown'}
 */
export function sourceKind(sourceString) {
  return SOURCE_STRING_KIND[sourceString] ?? 'unknown';
}

/** True only for adapters that perform real public discovery. */
export function isDiscoveryAdapter(adapter) {
  return DISCOVERY_ADAPTERS.has(adapter);
}
