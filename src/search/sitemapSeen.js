/**
 * Which posting URLs each careers sitemap listed on its last crawl (audit D4).
 *
 * WHY. Many career sites behind a sitemap publish job pages with no posting
 * date at all — SAP SuccessFactors/RMK sites (Capgemini, EY, Wipro) and KPMG's
 * among them. The freshness gate drops an undated posting, so on the live store
 * all 353 rows from those four employers were discarded as "unknown posting
 * date" and none was ever judged. A sitemap's `<lastmod>` does not help: EY
 * stamps every URL with the same crawl date.
 *
 * What CAN be known honestly is whether a URL is new to the sitemap. A URL
 * absent from the previous crawl's listing appeared since then, so the time of
 * this crawl is a sound upper bound on its age. Such a posting is dated
 * `first_seen` (and labelled so); everything else stays undated. On a
 * sitemap's FIRST crawl nothing is "new", so its undated backlog still goes to
 * the unknown-date review rather than the board.
 *
 * Stored per workspace as short hashes of the normalized URL, so a 20,000-URL
 * sitemap costs ~200 KB, not megabytes.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../utils/fsSafe.js';
import { workspacePaths } from '../profile/workspace.js';
import { urlKeyFor } from './deduplicator.js';

/** FNV-1a 32-bit, base36: short, stable, collision-safe at this scale. */
function hashUrl(url) {
  const key = urlKeyFor({ url }) ?? String(url ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** @param {string} root */
export function sitemapSeenPath(root) {
  return join(workspacePaths(root).dataDir, 'sitemap_seen.json');
}

/**
 * @param {object} [options]
 * @param {string|null} [options.root] null keeps state in memory (tests)
 * @param {(p: string) => string} [options.readFileImpl]
 * @param {(p: string, d: string) => void} [options.writeFileImpl]
 */
export function createSitemapSeen({ root = null, readFileImpl, writeFileImpl } = {}) {
  const path = root ? sitemapSeenPath(root) : null;
  const read = readFileImpl ?? ((p) => readFileSync(p, 'utf8'));
  const write = writeFileImpl ?? ((p, d) => writeFileAtomic(p, d, 'utf8'));
  /** @type {Record<string, {crawledAt: string, urls: string[]}>} */
  let sitemaps = {};
  if (path) {
    try {
      const parsed = JSON.parse(read(path));
      if (parsed?.sitemaps && typeof parsed.sitemaps === 'object') sitemaps = parsed.sitemaps;
    } catch {
      sitemaps = {};
    }
  }
  const sets = new Map();
  let dirty = false;

  /**
   * The previous crawl of one sitemap, or null on its first crawl.
   * @param {string} key the sitemap URL
   * @returns {{crawledAt: string, has: (url: string) => boolean}|null}
   */
  function previous(key) {
    const entry = sitemaps[key];
    if (!entry?.crawledAt || !Array.isArray(entry.urls)) return null;
    if (!sets.has(key)) sets.set(key, new Set(entry.urls));
    const set = sets.get(key);
    return { crawledAt: entry.crawledAt, has: (url) => set.has(hashUrl(url)) };
  }

  /**
   * Replace the record for one sitemap with this crawl's full job-URL listing.
   * @param {string} key
   * @param {string[]} urls
   * @param {Date} [at]
   */
  function record(key, urls, at = new Date()) {
    sitemaps[key] = { crawledAt: at.toISOString(), urls: [...new Set(urls.map(hashUrl))] };
    sets.delete(key);
    dirty = true;
  }

  function save() {
    if (!path || !dirty) return;
    try {
      write(path, `${JSON.stringify({ version: 1, sitemaps })}\n`);
      dirty = false;
    } catch { /* a hint: losing it delays first-seen dating by one crawl */ }
  }

  return { previous, record, save, path };
}
