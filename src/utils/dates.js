/**
 * Date helpers for job freshness and timestamps.
 * Deterministic and timezone-safe (UTC-based) so scoring is reproducible.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Current time as an ISO-8601 string (UTC).
 * @returns {string}
 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Parse a value into a Date, returning null when it cannot be parsed.
 * Accepts Date instances, epoch numbers, and date strings.
 * @param {unknown} value
 * @returns {Date|null}
 */
export function parseDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Whole days between two dates (a - b), floored.
 * @param {Date|string|number} a
 * @param {Date|string|number} b
 * @returns {number|null} null if either date is unparseable
 */
export function daysBetween(a, b) {
  const da = parseDate(a);
  const db = parseDate(b);
  if (!da || !db) return null;
  return Math.floor((da.getTime() - db.getTime()) / MS_PER_DAY);
}

/**
 * Age of a posting in whole days relative to `reference` (default: now).
 * @param {Date|string|number} postedAt
 * @param {Date|string|number} [reference]
 * @returns {number|null} null if postedAt is unparseable
 */
export function ageInDays(postedAt, reference = new Date()) {
  const posted = parseDate(postedAt);
  if (!posted) return null;
  return daysBetween(reference, posted);
}

/**
 * True when a posting is older than `maxDays`.
 * Unknown/unparseable dates are treated as NOT stale (caller decides handling).
 * @param {Date|string|number} postedAt
 * @param {number} maxDays
 * @param {Date|string|number} [reference]
 * @returns {boolean}
 */
export function isStale(postedAt, maxDays, reference = new Date()) {
  const age = ageInDays(postedAt, reference);
  if (age === null) return false;
  return age > maxDays;
}

/**
 * Compact date stamp (YYYYMMDD) for output filenames, UTC-based.
 * @param {Date|string|number} [value]
 * @returns {string}
 */
export function dateStamp(value = new Date()) {
  const d = parseDate(value) ?? new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * True when a posting was published within the requested number of hours (or in the
 * future, e.g. a feed that timestamps slightly ahead). Unknown/unparseable
 * dates return false. Used to surface and rank the freshest roles first.
 * @param {Date|string|number} postedAt
 * @param {number} hours
 * @param {Date|string|number} [reference]
 * @returns {boolean}
 */
export function isWithinLastHours(postedAt, hours, reference = new Date()) {
  const posted = parseDate(postedAt);
  const ref = parseDate(reference) ?? new Date();
  const windowHours = Number(hours);
  if (!posted || !Number.isFinite(windowHours) || windowHours <= 0) return false;
  return ref.getTime() - posted.getTime() < windowHours * 60 * 60 * 1000;
}

/** Backward-compatible convenience wrapper used by existing freshness metrics. */
export function isWithinLast24Hours(postedAt, reference = new Date()) {
  return isWithinLastHours(postedAt, 24, reference);
}

const MONTH_ABBR = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]);

/**
 * Short, human-friendly "posted" label for console/report display.
 *
 *   - within last 24h (or future)  -> "Today"
 *   - 1-6 whole days old           -> "1d ago" ... "6d ago"
 *   - 7+ days old                  -> "Jun 6"  (UTC month + day)
 *   - unknown/unparseable          -> "Unknown"
 *
 * Never fabricates a date: a missing postedAt always yields "Unknown".
 * @param {Date|string|number} postedAt
 * @param {Date|string|number} [reference]
 * @returns {string}
 */
export function formatPostedRelative(postedAt, reference = new Date()) {
  const posted = parseDate(postedAt);
  if (!posted) return 'Unknown';
  if (isWithinLast24Hours(posted, reference)) return 'Today';
  const age = ageInDays(posted, reference);
  if (age !== null && age >= 1 && age <= 6) return `${age}d ago`;
  return `${MONTH_ABBR[posted.getUTCMonth()]} ${posted.getUTCDate()}`;
}
