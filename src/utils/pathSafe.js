/**
 * Path containment check for artifact reads.
 *
 * Every file the dashboard serves (tailored resume, cover letter, packet) must
 * live inside the Job Agent workspace. The obvious implementation —
 * `child.startsWith(parent + sep)` — is subtly wrong on Windows, and the bug it
 * caused was total: `realpathSync` PRESERVES the drive-letter case of whatever
 * you pass it, so a workspace resolved as `c:\job-agent` never matched a stored
 * artifact path of `C:\job-agent\...`, and the dashboard answered 403 for every
 * resume preview and download.
 *
 * Lowercasing everything would be wrong in the other direction: Linux and macOS
 * filesystems are case-sensitive, and `/ws/Resume.pdf` must not be treated as
 * living under `/ws/resume/`. `path.relative` already applies the correct
 * platform semantics (case-insensitive on win32, case-sensitive elsewhere), so
 * we let Node decide instead of hand-rolling string comparison.
 */

import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Is `child` the directory `parent` itself, or something inside it?
 *
 * Rejects sibling directories that merely share a name prefix
 * (`/ws` vs `/ws-evil`), parent traversal, and other drives/roots.
 *
 * @param {string} parent containing directory (already resolved/realpath'd)
 * @param {string} child candidate path (already resolved/realpath'd)
 * @returns {boolean}
 */
export function isInsideDirectory(parent, child) {
  if (!parent || !child) return false;
  const rel = relative(resolve(parent), resolve(child));
  // '' means the paths are the same directory.
  if (rel === '') return true;
  // A path outside `parent` needs '..' to get there, or is on another root
  // (in which case `relative` returns an absolute path).
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Assert containment, throwing an HTTP-shaped error when it fails.
 *
 * @param {string} parent workspace root
 * @param {string} child resolved candidate path
 * @param {string} [message] error message for the 403
 * @returns {string} the child path, for chaining
 */
export function assertInsideDirectory(parent, child, message = 'path escapes the Job Agent workspace') {
  if (!isInsideDirectory(parent, child)) {
    throw Object.assign(new Error(message), { statusCode: 403 });
  }
  return child;
}
