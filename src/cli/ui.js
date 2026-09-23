// @ts-check
/**
 * Console reporter — clean, human-friendly terminal output.
 *
 * The structured pino logger still writes the full JSON audit trail to
 * logs/run-<id>.log. This module is purely for what a person reads in the
 * terminal: short headings, key/value summaries, affected files, and clear
 * "what to do next" guidance. No dependencies; degrades gracefully when the
 * terminal has no color support (or NO_COLOR is set).
 */

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const CODES = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

/** Wrap text in an ANSI color (no-op when color is unsupported). */
function paint(code, text) {
  return useColor ? `${code}${text}${CODES.reset}` : String(text);
}

const c = {
  bold: (s) => paint(CODES.bold, s),
  dim: (s) => paint(CODES.dim, s),
  red: (s) => paint(CODES.red, s),
  green: (s) => paint(CODES.green, s),
  yellow: (s) => paint(CODES.yellow, s),
  blue: (s) => paint(CODES.blue, s),
  magenta: (s) => paint(CODES.magenta, s),
  cyan: (s) => paint(CODES.cyan, s),
  gray: (s) => paint(CODES.gray, s),
};

const WIDTH = 60;

/** A titled section header, e.g. ══ Discover ═══════════ */
function heading(title) {
  // Always leave room for the leading "══" (2) + spaces (2) + a minimum
  // trailing bar (3) so long titles get truncated instead of overflowing the
  // line and dropping the trailing border.
  const MIN_BAR = 3;
  const maxTitle = WIDTH - 2 - 2 - MIN_BAR;
  let text = String(title);
  if (text.length > maxTitle) text = `${text.slice(0, Math.max(0, maxTitle - 1))}…`;
  const label = ` ${text} `;
  const bar = '═'.repeat(Math.max(MIN_BAR, WIDTH - label.length - 2));
  process.stdout.write(`\n${c.cyan('══')}${c.bold(label)}${c.cyan(bar)}\n`);
}

/** A one-line "what's happening now" note under a heading. */
function step(text) {
  process.stdout.write(`${c.dim(text)}\n`);
}

/** Blank line. */
function blank() {
  process.stdout.write('\n');
}

/**
 * Aligned key/value stat block.
 * @param {Array<[string, string|number, ('good'|'warn'|'bad'|'muted')?]>} rows
 */
function stats(rows) {
  const labelW = Math.max(...rows.map(([k]) => String(k).length));
  for (const [label, value, tone] of rows) {
    const padded = String(label).padEnd(labelW);
    let v = String(value);
    if (tone === 'good') v = c.green(v);
    else if (tone === 'warn') v = c.yellow(v);
    else if (tone === 'bad') v = c.red(v);
    else if (tone === 'muted') v = c.dim(v);
    process.stdout.write(`  ${c.dim(padded)}  ${c.bold(v)}\n`);
  }
}

/** A list of bullet lines under an optional label. */
function list(label, items, { symbol = '•' } = {}) {
  if (label) process.stdout.write(`${c.bold(label)}\n`);
  if (!items.length) {
    process.stdout.write(`  ${c.dim('(none)')}\n`);
    return;
  }
  for (const item of items) process.stdout.write(`  ${c.cyan(symbol)} ${item}\n`);
}

/** "Files written / updated" block. Paths are shown as given (relativize first). */
function files(paths) {
  const clean = paths.filter(Boolean);
  if (!clean.length) return;
  process.stdout.write(`${c.bold('Files updated')}\n`);
  for (const p of clean) process.stdout.write(`  ${c.gray('›')} ${p}\n`);
}

/** Numbered "do this next" guidance. Accepts strings or {text, cmd}. */
function next(items) {
  if (!items?.length) return;
  process.stdout.write(`${c.bold('Next steps')}\n`);
  items.forEach((item, i) => {
    const n = c.cyan(`${i + 1}.`);
    if (typeof item === 'string') {
      process.stdout.write(`  ${n} ${item}\n`);
    } else {
      const label = item.text ? `${item.text}  ` : '';
      process.stdout.write(`  ${n} ${label}${c.green(item.cmd)}\n`);
    }
  });
}

/** Simple aligned table from an array of objects (keys = columns). */
function table(rows) {
  if (!rows.length) {
    process.stdout.write(`  ${c.dim('(none)')}\n`);
    return;
  }
  const cols = Object.keys(rows[0]);
  const widths = cols.map((col) =>
    Math.max(col.length, ...rows.map((r) => String(r[col] ?? '').length)));
  const header = cols.map((col, i) => c.dim(col.padEnd(widths[i]))).join('  ');
  process.stdout.write(`  ${header}\n`);
  for (const row of rows) {
    const line = cols.map((col, i) => String(row[col] ?? '').padEnd(widths[i])).join('  ');
    process.stdout.write(`  ${line}\n`);
  }
}

function success(text) { process.stdout.write(`${c.green('✓')} ${text}\n`); }
function warn(text) { process.stdout.write(`${c.yellow('!')} ${c.yellow(text)}\n`); }
function fail(text) { process.stderr.write(`${c.red('✗')} ${c.red(text)}\n`); }
function note(text) { process.stdout.write(`${c.dim(text)}\n`); }

export const ui = {
  c, heading, step, blank, stats, list, files, next, table, success, warn, fail, note,
};
