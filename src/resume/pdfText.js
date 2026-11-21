/**
 * PDF resume -> the same paragraph list `extractDocxText` gives for a .docx.
 *
 * WHY THIS IS MORE THAN "GET THE TEXT"
 * ------------------------------------
 * A PDF has no paragraphs. It has glyph runs placed at coordinates, so a naive
 * text dump hands the resume parser:
 *   - every wrapped bullet as two or three separate "lines", the tail of which
 *     ("and Industrial domains, with …") reads like a heading or a job title;
 *   - a two-column resume interleaved row by row, so the sidebar's SKILLS lines
 *     land in the middle of EXPERIENCE;
 *   - right-aligned dates glued to the job title with no separator.
 * The parser in src/profile/fromResume.js was tuned on Word paragraphs, so this
 * module rebuilds them from the layout instead:
 *
 *   1. runs -> lines         (same baseline, tolerant of sub/superscript drift)
 *   2. lines -> segments     (a wide horizontal gap is a tab stop or column, not a space)
 *   3. columns               (a vertical gutter that almost no line crosses; the
 *                             left column is read before the right one)
 *   4. lines -> paragraphs   (a line that ran to the right edge wrapped; a line
 *                             starting lower-case continues; a bullet glyph starts
 *                             a new paragraph and is then dropped, because a Word
 *                             list bullet is numbering, not text)
 *
 * Everything is deterministic geometry. What cannot be recovered is said, not
 * guessed: a scanned PDF (no text layer) is refused with a message saying so.
 */


/** Read at most this many pages; a resume is 1–3, and a 300-page upload is a mistake. */
const MAX_PAGES = 10;

/** Fewer characters than this across the whole file means there is no text layer. */
const MIN_TEXT_CHARS = 40;

/** Leading glyphs that are bullets: real ones, dashes, and Symbol/Wingdings private-use codes. */
const BULLET_RE = /^(?:(?:[\u2022\u25CF\u25CB\u25E6\u25AA\u25AB\u25A0\u25A1\u25C6\u25C7\u25BA\u25B6\u25B8\u2023\u2043\u2219\u00B7\u27A2\u27A4\u2713\u2714\u2717]|[\uE000-\uF8FF])\s*|[*\u2013\u2014-]\s+)/u;

/** A line that opens with a short "Label:" (a skills row, "Email:", "Tools:"). */
const LABEL_LEAD_RE = /^[A-Z][A-Za-z0-9 &/+.,'()-]{1,40}:\s/;

/** An email address, a web address or a phone number. */
const CONTACT_RE = /[\w.+-]+@[\w-]+\.[\w.]+|https?:\/\/|\bwww\.|\b(?:linkedin|github)\.com\b|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/i;

class PdfReadError extends Error {
  /** @param {string} message @param {{code?: string}} [options] */
  constructor(message, { code = 'PDF_UNREADABLE' } = {}) {
    super(message);
    this.name = 'PdfReadError';
    this.code = code;
    this.statusCode = 422;
  }
}

/**
 * Cheap magic-byte check. The spec lets "%PDF-" appear anywhere in the first
 * 1024 bytes (some generators prepend junk), so look there, not only at 0.
 * @param {Buffer} buffer
 */
export function isPdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false;
  return buffer.subarray(0, 1024).includes('%PDF-');
}

/**
 * Extract a PDF's readable text as paragraphs.
 *
 * @param {Buffer} buffer the whole file
 * @returns {Promise<{ paragraphs: string[], text: string, wordCount: number, pages: number, links: string[] }>}
 * @throws {PdfReadError} when the file is not a readable PDF or has no text layer
 */
export async function extractPdfText(buffer) {
  if (!isPdfBuffer(buffer)) throw new PdfReadError('the file is not a PDF');
  // Loaded on first use: the dashboard imports this module for isPdfBuffer,
  // and most sessions never read a PDF.
  const { getDocumentProxy } = await import('unpdf');
  let pdf;
  try {
    // isEvalSupported: false — font programs are never compiled into JS
    // (CVE-2024-4367 class). Nothing is rendered, so fonts are not loaded.
    pdf = await getDocumentProxy(new Uint8Array(buffer), {
      isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0,
    });
  } catch (err) {
    if (err?.name === 'PasswordException') {
      throw new PdfReadError('that PDF is password-protected — save a copy without a password and try again', { code: 'PDF_ENCRYPTED' });
    }
    throw new PdfReadError('that PDF could not be read — it may be damaged; try exporting it again');
  }
  try {
    const pages = Math.min(pdf.numPages, MAX_PAGES);
    const paragraphs = [];
    const links = new Set();
    for (let n = 1; n <= pages; n += 1) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const [x0, y0, x1, y1] = page.view;
      paragraphs.push(...paragraphsFromItems(content.items, { width: x1 - x0, top: y1, height: y1 - y0, firstPage: n === 1 }));
      for (const a of await page.getAnnotations().catch(() => [])) {
        if (a?.subtype === 'Link' && typeof a.url === 'string') links.add(a.url);
      }
      page.cleanup();
    }
    const text = paragraphs.join('\n');
    if (text.replace(/\s/g, '').length < MIN_TEXT_CHARS) {
      throw new PdfReadError(
        'that PDF has no selectable text (it looks like a scan or a picture) — use a .docx, or a PDF saved from Word or Google Docs',
        { code: 'PDF_NO_TEXT' },
      );
    }
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return { paragraphs, text, wordCount, pages, links: [...links] };
  } finally {
    await pdf.loadingTask?.destroy().catch(() => {});
  }
}

/* ───────────────────────── layout reconstruction ───────────────────────── */

/**
 * @typedef {{ str: string, x0: number, x1: number, y: number, size: number }} Run
 * @typedef {{ text: string, x0: number, x1: number, y: number, size: number, bullet: boolean }} Segment
 */

/**
 * One page's pdf.js text items -> paragraphs. Exported for tests, which feed
 * hand-built items so every layout rule can be checked without a PDF file.
 *
 * @param {Array<{ str: string, transform: number[], width: number, height?: number }>} items
 * @param {{ width?: number, top?: number, height?: number, firstPage?: boolean }} [page]
 * @returns {string[]}
 */
export function paragraphsFromItems(items = [], { width = 612, top = 792, height = 792, firstPage = true } = {}) {
  const runs = toRuns(items);
  if (!runs.length) return [];
  const segments = toLines(runs).flatMap(splitSegments);
  const flows = orderByColumns(segments, width);
  const paragraphs = flows.flatMap(joinParagraphs);
  if (firstPage) nameFirst(paragraphs, { top, height });
  return paragraphs.map((p) => tidy(p.text)).filter(Boolean);
}

/**
 * The name goes first. It is the largest text at the top of page 1, but a
 * header that sets the name beside a stack of small contact lines can put the
 * name's baseline BELOW the first contact line, and the parser reads the
 * first header line as the name. Moved only when it is clearly larger than
 * everything else and sits in the top quarter of the page.
 */
function nameFirst(paragraphs, { top, height }) {
  if (paragraphs.length < 2) return;
  const sizes = paragraphs.map((p) => p.size).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)];
  let best = -1;
  paragraphs.forEach((p, i) => {
    if (top - p.y > 0.25 * height) return;
    if (best < 0 || p.size > paragraphs[best].size) best = i;
  });
  if (best <= 0 || paragraphs[best].size < 1.4 * median) return;
  // Only short text is a name; a big tagline or banner is left where it is.
  if (paragraphs[best].text.split(' ').length > 5) return;
  paragraphs.unshift(...paragraphs.splice(best, 1));
}

/** Text items -> horizontal runs with a usable font size. Rotated text (margin stamps) is skipped. */
function toRuns(items) {
  const runs = [];
  for (const it of items) {
    if (!it || typeof it.str !== 'string' || !it.str.length || !Array.isArray(it.transform)) continue;
    const [a, b, c, d, e, f] = it.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue; // rotated or skewed
    const size = Math.abs(d) || Math.abs(a) || Number(it.height) || 10;
    // A whitespace-only run is kept only as a marker that a word gap exists.
    // Its WIDTH is ignored: pdf.js reports the stretch before a right-aligned
    // date as one 380pt "space", which would otherwise glue the date on.
    runs.push({ str: it.str.trim() ? it.str : ' ', x0: e, x1: e + (Number(it.width) || 0), y: f, size });
  }
  return runs;
}

/** Runs -> lines (arrays of runs sharing a baseline), top of the page first. */
function toLines(runs) {
  const sorted = [...runs].sort((p, q) => q.y - p.y || p.x0 - q.x0);
  const lines = [];
  for (const run of sorted) {
    const line = lines.at(-1);
    // Within a third of the font size counts as the same baseline: covers
    // superscripts ("1st"), mixed font sizes and generators that jitter y.
    if (line && Math.abs(line.y - run.y) <= Math.max(1.5, 0.35 * Math.min(line.size, run.size))) {
      line.runs.push(run);
      line.size = Math.max(line.size, run.size);
    } else {
      lines.push({ y: run.y, size: run.size, runs: [run] });
    }
  }
  for (const line of lines) line.runs.sort((p, q) => p.x0 - q.x0);
  return lines;
}

/**
 * A line -> segments. A gap wider than a few characters is a tab stop, a
 * right-aligned date or a second column, so it starts a new segment; a small
 * gap is a word space. Segments on one row are rejoined later (as a Word tab
 * reads), unless a column gutter puts them in different flows.
 *
 * @returns {Segment[]}
 */
function splitSegments(line) {
  const segments = [];
  let cur = null;
  let spaced = false;
  for (const run of line.runs) {
    if (run.str === ' ') { spaced = true; continue; }
    if (!cur) { cur = { text: run.str, x0: run.x0, x1: run.x1, y: line.y, size: run.size }; spaced = false; continue; }
    const gap = run.x0 - cur.x1;
    if (gap > Math.max(2.2 * Math.max(cur.size, run.size), 16)) {
      segments.push(cur);
      cur = { text: run.str, x0: run.x0, x1: run.x1, y: line.y, size: run.size };
    } else {
      const needsSpace = (spaced || gap > 0.18 * Math.min(line.size, run.size))
        && !/\s$/.test(cur.text) && !/^\s/.test(run.str);
      cur.text += (needsSpace ? ' ' : '') + run.str;
      cur.x1 = Math.max(cur.x1, run.x1);
      cur.size = Math.max(cur.size, run.size);
    }
    spaced = false;
  }
  if (cur) segments.push(cur);
  const out = [];
  for (const s of segments) {
    const text = s.text.replace(/\s+/g, ' ').trim();
    const bullet = BULLET_RE.test(text);
    const seg = { ...s, text: bullet ? text.replace(BULLET_RE, '') : text, bullet };
    // A bullet glyph set apart from its text (a hanging indent wider than the
    // split gap) lends its flag to the text beside it.
    const prev = out.at(-1);
    if (prev && prev.bullet && !prev.text) { out[out.length - 1] = { ...seg, bullet: true, x0: prev.x0 }; continue; }
    out.push(seg);
  }
  return out.filter((s) => s.text);
}

/**
 * Put segments in reading order. A single-column page is already in order. A
 * two-column page has a vertical gutter that almost no segment crosses: the
 * segments on each side are read as separate flows, left first, and anything
 * spanning the gutter (a full-width name or heading) is read where it sits,
 * splitting the columns above it from those below.
 *
 * @returns {Segment[][]} flows, in reading order
 */
function orderByColumns(segments, pageWidth) {
  const gutter = findGutter(segments, pageWidth);
  if (gutter == null) return [segments];
  const flows = [];
  let left = []; let right = [];
  const flush = () => { if (left.length) flows.push(left); if (right.length) flows.push(right); left = []; right = []; };
  for (const s of segments) {
    if (s.x1 <= gutter) left.push(s);
    else if (s.x0 >= gutter) right.push(s);
    else { flush(); flows.push([s]); }
  }
  flush();
  return flows;
}

/** A date or date range on its own ("2019 – 2021", "Mar 2021 – Present", "05/2020"). */
const DATE_ONLY_RE = /^[\s(]*(?:(?:[a-z]{3,9}\.?|\d{1,2}\/)\s*)?(?:19|20)\d{2}(?:\s*(?:[-–—]|to)\s*(?:(?:[a-z]{3,9}\.?|\d{1,2}\/)\s*)?(?:(?:19|20)\d{2}|present|current|now|date))?[\s)]*$/i;

/**
 * The x position of a column gutter, or null for a single-column page.
 * Requires several lines on each side, very few segments crossing it (so
 * wrapped body text never qualifies), and a side that is more than a stack of
 * right-aligned dates or places.
 */
function findGutter(segments, pageWidth) {
  if (segments.length < 10) return null;
  const minX = Math.min(...segments.map((s) => s.x0));
  const maxX = Math.max(...segments.map((s) => s.x1));
  const span = maxX - minX;
  if (span < 0.4 * pageWidth) return null;
  let best = null;
  // Candidate gutters: just right of each segment's end, inside the middle of the text.
  const candidates = [...new Set(segments.map((s) => Math.round(s.x1 + 3)))]
    .filter((x) => x > minX + 0.15 * span && x < maxX - 0.15 * span);
  for (const x of candidates) {
    const leftSide = []; const rightSide = []; let crossing = 0;
    for (const s of segments) {
      if (s.x1 <= x) leftSide.push(s);
      else if (s.x0 >= x) rightSide.push(s);
      else crossing += 1;
    }
    if (crossing > Math.max(2, 0.06 * segments.length)) continue;
    if (!realColumn(leftSide) || !realColumn(rightSide)) continue;
    const score = crossing * 1000 - Math.min(leftSide.length, rightSide.length);
    if (!best || score < best.score) best = { x, score };
  }
  return best?.x ?? null;
}

/** Enough lines, and not just the dates or places of a single-column layout's right edge. */
function realColumn(side) {
  if (side.length < 5) return false;
  const filler = side.filter((s) => DATE_ONLY_RE.test(s.text) || /^[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\b.{0,12}$/.test(s.text)).length;
  if (filler > 0.5 * side.length) return false;
  // Segments at distinct heights: a column is a stack, not one wide row cut in two.
  return new Set(side.map((s) => Math.round(s.y))).size >= 5;
}

/** Looks like a section heading: short, and all capitals or ending in a colon. */
function headingLike(text) {
  const t = text.trim();
  if (!t || t.length > 40) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  return (letters.length >= 3 && letters === letters.toUpperCase()) || /:$/.test(t);
}

/**
 * One flow's segments -> rows (segments that share a baseline, joined with a
 * space the way a Word tab reads: "Senior Analyst Mar 2021 – Present").
 */
function toRows(flow) {
  const rows = [];
  for (const s of flow) {
    const row = rows.at(-1);
    // A different size on the same baseline is a different thing: the name
    // on the left, the contact details on the right.
    if (row && Math.abs(row.y - s.y) < 0.5 && Math.abs(row.size - s.size) <= 1.5) {
      row.text += ` ${s.text}`;
      row.x1 = Math.max(row.x1, s.x1);
      row.tabbed = true;
      continue;
    }
    rows.push({ ...s, tabbed: false });
  }
  return rows;
}

/**
 * Rows of one flow -> paragraphs ({ text, size, y } of the first row). A row joins the previous one when it sits at
 * normal line spacing, has the same font size, does not start a bullet, and
 * the previous row evidently wrapped: it ran to the flow's right edge, ended
 * mid-phrase, or this row starts lower-case.
 */
function joinParagraphs(flow) {
  const rows = toRows(flow);
  if (!rows.length) return [];
  // The flow's right edge, from rows of running text (a tabbed row's date sits
  // at the margin whether or not anything wrapped).
  const plain = rows.filter((r) => !r.tabbed).map((r) => r.x1).sort((p, q) => p - q);
  const right = plain.length ? plain[Math.floor(plain.length * 0.9)] : Math.max(...rows.map((r) => r.x1));
  const left = Math.min(...rows.map((r) => r.x0));
  const width = Math.max(1, right - left);
  const out = [];
  let para = null;
  for (const r of rows) {
    if (para && continues(para, r, { right, width })) {
      para.text = /[a-z]-$/.test(para.text) && /^[a-z]/.test(r.text) ? para.text + r.text : `${para.text} ${r.text}`;
      para.last = r;
      continue;
    }
    if (para) out.push(para);
    para = { text: r.text, first: r, last: r, bullet: r.bullet, size: r.size, y: r.y };
  }
  if (para) out.push(para);
  return out;
}

function continues(para, r, { right, width }) {
  const prev = para.last;
  if (r.bullet || r.tabbed || prev.tabbed) return false;
  if (Math.abs(prev.size - r.size) > 0.6) return false;
  const leading = prev.y - r.y;
  if (leading <= 0 || leading > 1.6 * prev.size) return false; // a blank line, a jump or a new page
  if (headingLike(prev.text) || headingLike(r.text)) return false;
  // "Analytics & BI: Power BI, …" — a labelled row (skills, contact) is its own line.
  if (LABEL_LEAD_RE.test(r.text)) return false;
  // Contact lines stand alone; an email often starts lower-case under the name.
  if (CONTACT_RE.test(r.text) || CONTACT_RE.test(prev.text)) return false;
  // Under a bullet, a continuation is indented to the bullet's text, not left of the glyph.
  if (para.bullet && r.x0 < para.first.x0 - 2) return false;
  const slack = Math.min(7 * prev.size, 0.2 * width);
  // Only running text wraps: a stack of short items in a narrow sidebar
  // ("Power BI", "Inventory optimization") also reaches the edge.
  const ranToEdge = prev.x1 >= right - slack && !/[.!?:]$/.test(prev.text)
    && prev.text.split(' ').length >= 5;
  const midPhrase = /[,;&/(–-]$|\b(?:and|or|of|the|to|for|with|in|on|at|a|an|by|from|across|including|via)$/i.test(prev.text);
  const lowerStart = /^[a-z]/.test(r.text);
  return ranToEdge || midPhrase || lowerStart;
}

/** Final clean-up of one paragraph: ligatures, odd spaces, spacing around separators. */
function tidy(text) {
  return text
    .normalize('NFKC') // "ﬁ" -> "fi", full-width forms, non-breaking spaces
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '') // zero-width and soft hyphens
    .replace(/[\uE000-\uF8FF]/g, ' ') // private-use icon glyphs (phone, mail, pin)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .trim();
}

export { PdfReadError };
