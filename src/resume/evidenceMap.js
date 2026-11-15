/**
 * Requirement -> resume evidence (audit Backlog #6).
 *
 * "9 of 14 skills found" says nothing about WHERE. For each skill a posting
 * asks for, this finds the master resume's own lines that mention it, so the
 * person can see the proof (or see that there is none) before tailoring or
 * applying. Quotes only: nothing is generated, paraphrased or inferred, and a
 * skill with no line is reported as unproven rather than guessed at.
 *
 * Deterministic and pure apart from the cached master-resume read.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';

import { extractDocxText } from './docxText.js';
import { normalize, shows } from './evidence.js';
import { masterResumeFile } from '../profile/workspace.js';

/** Longest quote kept per line. */
const MAX_QUOTE = 200;
/** Lines kept per skill. */
const MAX_LINES = 2;

/**
 * The master resume's lines that mention each term.
 *
 * Asked of the one evidence check (src/resume/evidence.js, audit R13), so a
 * skill shown here is exactly a skill the score and the packet do not list as
 * a gap: same rules, same lines, same aliases. Short lines count too ("Tools:
 * Excel"); longer ones are quoted first.
 *
 * @param {string[]} terms skills the posting asks for
 * @param {string[]} lines the master resume, one paragraph per entry
 * @param {{aliases?: Record<string, string[]>, vocabulary?: string[]}} [options]
 * @returns {Array<{term: string, lines: string[]}>} in the order given; empty `lines` = not evidenced
 */
export function evidenceFor(terms = [], lines = [], { aliases = {}, vocabulary = [] } = {}) {
  const usable = lines.map((l) => String(l ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const aliasMap = new Map(Object.entries(aliases ?? {}).map(([k, v]) => [normalize(k), Array.isArray(v) ? v : []]));
  const out = [];
  const seen = new Set();
  for (const term of terms) {
    const key = String(term ?? '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const candidates = [term, ...(aliasMap.get(normalize(term)) ?? [])];
    // Bullets (longer, specific) before headings and skill lists.
    const hits = usable.filter((l) => candidates.some((c) => shows(c, l, { vocabulary })))
      .sort((a, b) => b.length - a.length).slice(0, MAX_LINES)
      .map((l) => (l.length > MAX_QUOTE ? `${l.slice(0, MAX_QUOTE - 1)}…` : l));
    out.push({ term: String(term).trim(), lines: hits });
  }
  return out;
}

const cache = new Map(); // path -> { mtimeMs, lines }

/**
 * The active person's master resume as lines, cached by modification time.
 * @param {string} root
 * @returns {string[]} empty when there is no readable master resume
 */
export function masterResumeLines(root) {
  try {
    const path = masterResumeFile(root);
    if (!existsSync(path)) return [];
    const { mtimeMs } = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.lines;
    const lines = extractDocxText(readFileSync(path)).paragraphs ?? [];
    cache.set(path, { mtimeMs, lines });
    return lines;
  } catch {
    return [];
  }
}
