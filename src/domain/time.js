/**
 * Calendar-day arithmetic in the CANDIDATE'S timezone.
 *
 * Every "today" in this product — "submitted today", the daily application
 * cap, the Today queue — is the user's day, not the UTC day. For a US Eastern
 * user the UTC day rolls over at 7–8 pm local, so a UTC-day cap reset in the
 * middle of an evening's applying (and a UTC-day tile read "0 submitted today"
 * while the evening's work was still happening). These helpers are the one
 * place that turns an instant into a local day, or a local day back into the
 * half-open UTC window a SQL query needs.
 */

/** The candidate's IANA timezone from a loadConfig() bundle, or null (UTC). */
export function candidateTimeZone(config) {
  const tz = config?.candidate?.location?.timezone;
  return typeof tz === 'string' && tz.trim() ? tz.trim() : null;
}

/** Cached formatters: constructing an Intl.DateTimeFormat costs ~20 µs. */
const DAY_FORMATTERS = new Map();
const PART_FORMATTERS = new Map();

function dayFormatter(timeZone) {
  let f = DAY_FORMATTERS.get(timeZone);
  if (!f) {
    // `en-CA` formats as YYYY-MM-DD, which is what every caller compares.
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    DAY_FORMATTERS.set(timeZone, f);
  }
  return f;
}

function partFormatter(timeZone) {
  let f = PART_FORMATTERS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    PART_FORMATTERS.set(timeZone, f);
  }
  return f;
}

/**
 * The calendar day a timestamp falls on, in `timeZone`.
 *
 * @param {unknown} value ISO timestamp (or Date)
 * @param {string|null} [timeZone] IANA zone; UTC slicing is the fallback
 * @returns {string} YYYY-MM-DD ('' for an empty value)
 */
export function dayOf(value, timeZone) {
  const raw = value instanceof Date ? value.toISOString() : String(value ?? '');
  if (!raw) return '';
  if (!timeZone) return raw.slice(0, 10);
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return raw.slice(0, 10);
  try {
    return dayFormatter(timeZone).format(at);
  } catch {
    // An unknown/invalid zone must not break the dashboard.
    return raw.slice(0, 10);
  }
}

/** Milliseconds `timeZone` is ahead of UTC at `instantMs`. */
function zoneOffsetMs(instantMs, timeZone) {
  const parts = {};
  for (const p of partFormatter(timeZone).formatToParts(new Date(instantMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  return asUtc - (instantMs - (instantMs % 1000));
}

/** The UTC instant of local midnight at the start of Y-M-D in `timeZone`. */
function localMidnightMs(year, month, day, timeZone) {
  const guess = Date.UTC(year, month - 1, day);
  // Two passes: the offset AT local midnight can differ from the offset at
  // UTC midnight on a DST changeover day.
  const first = guess - zoneOffsetMs(guess, timeZone);
  return guess - zoneOffsetMs(first, timeZone);
}

/**
 * The half-open UTC window [start, end) of the local day containing `now`.
 *
 * Suitable for `applied_at >= ? AND applied_at < ?` against ISO-8601 UTC
 * strings, which sort lexicographically in time order.
 *
 * @param {Date} [now]
 * @param {string|null} [timeZone] null/invalid -> the UTC day
 * @returns {{ day: string, start: string, end: string }}
 */
export function localDayWindow(now = new Date(), timeZone = null) {
  const day = dayOf(now.toISOString(), timeZone);
  const [y, m, d] = day.split('-').map(Number);
  let startMs;
  let endMs;
  try {
    if (!timeZone) throw new Error('utc');
    startMs = localMidnightMs(y, m, d, timeZone);
    endMs = localMidnightMs(y, m, d + 1, timeZone);
  } catch {
    startMs = Date.UTC(y, m - 1, d);
    endMs = Date.UTC(y, m - 1, d + 1);
  }
  return { day, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}
