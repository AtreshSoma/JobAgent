/** Pure text formatting shared by the dashboard views (no DOM access). */
/**
 * One header line for a location, however many sites the posting lists.
 *
 * Multi-state requisitions store every site ("PA, Working at Home - Pennsylvania;
 * MD, Working at Home - Maryland; …" — 1,926 characters on the live store),
 * which pushed the grade, chips and actions a full screen below the title.
 * The complete list stays in the tooltip and in the posting itself.
 */
export function compactLocation(location, { maxSites = 2, maxChars = 90 } = {}) {
  const text = String(location ?? '').trim();
  if (!text) return '';
  const sites = text.split(/\s*[;|]\s*/).filter(Boolean);
  if (sites.length > maxSites) {
    return `${sites.slice(0, maxSites).join('; ')} + ${sites.length - maxSites} more`;
  }
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
}

/** Whole days since an ISO date, or null when there is no usable date. */
export function ageDays(iso, now = Date.now()) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/**
 * How current a posting is, in three words the whole UI shares:
 *   fresh  — posted within a week
 *   aging  — 8 to 30 days: still worth applying to, worth knowing
 *   stale  — over 30 days: likely filled; check the link before investing time
 * Null when the date is unknown (that has its own "date unknown" treatment).
 */
export function freshnessOf(iso, now = Date.now()) {
  const days = ageDays(iso, now);
  if (days === null) return null;
  return { days, tone: days <= 7 ? 'fresh' : days <= 30 ? 'aging' : 'stale' };
}

/**
 * Skill terms minus those that are part of the role's own title. Mirrors
 * titleFreeSkills in src/dashboard/data.js so a row's "7 of 12 skills" and
 * the detail card count the same things.
 */
export function withoutTitleTerms(terms = [], title = '') {
  const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();
  const t = ` ${norm(title)} `;
  return terms.filter((term) => !t.includes(` ${norm(term)} `));
}

/**
 * A resume line that is almost certainly a section heading, so the plain-text
 * preview keeps the document's shape instead of reading as one grey wall.
 */
export function looksLikeHeading(line) {
  const text = String(line).trim();
  if (text.length > 48 || /[.;]$/.test(text)) return false;
  return text === text.toUpperCase() ? /[A-Z]/.test(text) : /^[A-Z][\w/&' -]*$/.test(text);
}

/** A month name or "Present" next to a year: the date line of a role, in any field. */
const DATE_LINE = /\b(19|20)\d{2}\b/;
const DATE_WORD = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\bpresent\b|\bcurrent\b|\d{1,2}\/\d{2,4}/i;

/**
 * Classify one plain-text resume line, so the preview keeps the document's
 * shape instead of reading as one flat wall where a job title and a bullet
 * weigh the same.
 *
 * Deliberately profession-neutral: it reads STRUCTURE (headings, short lines
 * joined by "|" or "—", lines that carry a date range) rather than any
 * field's vocabulary, so a nurse's or an accountant's resume shapes the same
 * way an engineer's does. When unsure, a line is plain text.
 *
 * @param {string} line
 * @param {{ beforeFirstHeading: boolean, index: number }} at  index = line number in the document
 * @returns {'name'|'contact'|'heading'|'when'|'role'|'item'}
 */
export function classifyResumeLine(line, { beforeFirstHeading, index }) {
  const text = String(line).trim();
  // The name-and-contact block: the top lines above the first heading, and
  // never more than four — some resumes carry no heading until page two.
  if (beforeFirstHeading && index === 0) return 'name';
  const short = text.length <= 90 && !/[.;:]$/.test(text);
  // Dates before headings: "Aug 2018 - Present" is title-case and short, so
  // the heading test alone styled every date line as a section heading.
  if (short && DATE_LINE.test(text) && DATE_WORD.test(text)) return 'when';
  if (looksLikeHeading(text)) return 'heading';
  if (beforeFirstHeading && index < 4 && text.length <= 140) return 'contact';
  if (short && /\s[|—–]\s/.test(text)) return 'role';
  return 'item';
}

/** "JORDAN A RIVERA" -> "Jordan A Rivera"; a name typed in mixed case is left as written. */
export function displayName(name) {
  const text = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!text || /[a-z]/.test(text)) return text;
  return text.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, lead, ch) => lead + ch.toUpperCase());
}

/** Two letters: first and last name ("Jordan A Rivera" -> "JR"). */
export function initials(name) {
  const words = displayName(name).split(' ').filter((w) => /[A-Za-z]/.test(w));
  if (!words.length) return '';
  const last = words.length > 1 ? words.at(-1) : '';
  return `${words[0][0]}${last ? last[0] : ''}`.toUpperCase();
}
