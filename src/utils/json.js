/**
 * Tiny JSON parsing helpers shared across the CLI, dashboard, and reports.
 */

/**
 * Parse a SQLite TEXT column that may hold a JSON array (list columns like
 * matched_keywords / assist_blockers). Anything unparseable is an empty list.
 *
 * @param {unknown} value raw column value (array passthrough, JSON string, or junk)
 * @returns {unknown[]}
 */
export function jsonList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}
