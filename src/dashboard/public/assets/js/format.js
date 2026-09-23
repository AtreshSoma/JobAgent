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
