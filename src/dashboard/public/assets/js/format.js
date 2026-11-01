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
