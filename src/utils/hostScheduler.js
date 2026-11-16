/**
 * Run a few jobs at once without two ever sharing a host (audit A11).
 *
 * An ATS rate-limits and flags a burst from one account, so a batch may fill
 * several applications together only when they are on different hosts. The
 * limit is clamped to 1..3 and the default is 1 (strictly sequential). Results
 * come back in input order. A cancel stops anything new from starting; jobs
 * already running finish. After a failure nothing new starts, the running jobs
 * finish, and the first error is thrown, which is what a sequential loop did.
 */

/** The key two jobs must not share: an ATS's registrable host (tenants of one ATS share it). */
export function hostKey(url) {
  try {
    const labels = new URL(url).hostname.toLowerCase().split('.').filter(Boolean);
    return labels.length <= 2 ? labels.join('.') : labels.slice(-2).join('.');
  } catch {
    return String(url ?? '');
  }
}

export const MAX_CONCURRENCY = 3;

/** A usable limit from a setting that may be missing or silly. */
export function clampConcurrency(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_CONCURRENCY);
}

/**
 * @template T, R
 * @param {T[]} items
 * @param {{concurrency?: number, keyOf: (item: T) => string, worker: (item: T, index: number) => Promise<R>,
 *   shouldCancel?: () => boolean}} options
 * @returns {Promise<R[]>} one entry per item, in order; undefined for an item that never started
 */
export async function runLimited(items, { concurrency = 1, keyOf, worker, shouldCancel } = {}) {
  const limit = clampConcurrency(concurrency);
  const results = new Array(items.length);
  const pending = items.map((_, i) => i);
  const activeKeys = new Set();
  let running = 0;
  let failure = null;

  return new Promise((resolve, reject) => {
    const finishIfDone = () => {
      const stopped = failure !== null || shouldCancel?.() === true;
      if (running === 0 && (pending.length === 0 || stopped)) {
        if (failure) reject(failure.error); else resolve(results);
        return true;
      }
      return false;
    };
    const pump = () => {
      while (running < limit && !failure && !shouldCancel?.()) {
        const at = pending.findIndex((i) => !activeKeys.has(keyOf(items[i])));
        if (at < 0) break;
        const [index] = pending.splice(at, 1);
        const key = keyOf(items[index]);
        activeKeys.add(key);
        running += 1;
        Promise.resolve()
          .then(() => worker(items[index], index))
          .then((value) => { results[index] = value; })
          .catch((error) => { failure ??= { error }; })
          .finally(() => { activeKeys.delete(key); running -= 1; pump(); });
      }
      finishIfDone();
    };
    pump();
  });
}
