/**
 * Bounded-concurrency helpers.
 *
 * Discovery fans out to dozens of public job-board endpoints. Running them one
 * at a time (sequential `await`) is the single biggest reason a "find jobs" run
 * drags on for minutes. These helpers run work in parallel up to a fixed
 * ceiling so we stay fast AND polite (the ceiling is the politeness mechanism —
 * never evasion).
 */

/**
 * Run `mapper` over `items` with at most `limit` in flight at once.
 *
 * Results are returned in the SAME ORDER as `items` (not completion order) so
 * downstream behavior (e.g. dedup tie-breaking, report ordering) stays
 * deterministic regardless of which request finishes first.
 *
 * The mapper is expected to handle its own errors. If it throws, the rejection
 * is captured and returned as `{ ok: false, error }` for that slot so one bad
 * item never aborts the whole batch. Successful slots are `{ ok: true, value }`.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit max concurrent invocations (clamped to >= 1)
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @param {object} [options]
 * @param {(item: T, index: number) => number} [options.costOf] expected cost of
 *   an item. When given, work is CLAIMED longest-first. Results are still
 *   returned in input order — this only changes the schedule.
 * @returns {Promise<Array<{ ok: true, value: R } | { ok: false, error: any }>>}
 */
export async function mapSettled(items, limit, mapper, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  if (list.length === 0) return results;

  const ceiling = Math.max(1, Math.min(Number(limit) || 1, list.length));

  // The ORDER WORK IS CLAIMED IN, which is not the order results come back in.
  // `results[index]` is always written at the item's original position, so
  // callers see input order no matter how this is sorted — only the schedule
  // changes. Default is input order.
  const order = list.map((_, i) => i);
  if (typeof options.costOf === 'function') {
    // Longest-processing-time-first. With a bounded pool, starting the longest
    // item last leaves it running alone after everything else has drained, and
    // the run cannot finish before it does. Starting it first overlaps it with
    // the short work instead. Ties keep input order so the schedule stays
    // deterministic.
    const cost = list.map((item, i) => Number(options.costOf(item, i)) || 0);
    order.sort((a, b) => (cost[b] - cost[a]) || (a - b));
  }

  let cursor = 0;

  async function worker() {
    for (;;) {
      const slot = cursor;
      cursor += 1;
      if (slot >= order.length) return;
      const index = order[slot];
      try {
        results[index] = { ok: true, value: await mapper(list[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: ceiling }, () => worker()));
  return results;
}

/**
 * Like {@link mapSettled} but returns the mapper's values directly (in input
 * order). Use this when the mapper already returns a safe value for every item
 * (never throws), e.g. an adapter board-runner that captures its own errors.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, limit, mapper) {
  const settled = await mapSettled(items, limit, mapper);
  return settled.map((r) => (r.ok ? r.value : undefined));
}
