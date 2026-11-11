/**
 * Crash-safe file writes.
 *
 * Plain `writeFileSync` truncates the target first, so a reader that opens the
 * file mid-write (the dashboard reading a packet, Excel holding job_tracker.csv,
 * a second process rewriting the same artifact) sees a partial file — and a
 * crash mid-write leaves it corrupted forever. `writeFileAtomic` writes to a
 * temp file in the same directory and renames it over the target: readers see
 * either the old complete file or the new complete file, never a torn one.
 */

import { writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

/**
 * Atomically write `data` to `path` (temp file + rename, same directory so the
 * rename never crosses filesystems). Creates parent directories as needed.
 *
 * @param {string} path target file path
 * @param {string|Buffer} data
 * @param {string|object} [options='utf8'] encoding or fs options
 */
export function writeFileAtomic(path, data, options = 'utf8') {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // Unique-enough temp name: pid + time + random, dot-prefixed so artifact
  // globs/dir listings skimming for *.json/*.csv never pick up a temp file.
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    writeFileSync(tmp, data, options);
    renameSync(tmp, path); // atomic on POSIX; MoveFileEx-replace semantics on Windows
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort cleanup */ }
    throw err;
  }
}
