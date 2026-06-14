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
 * @returns {Promise<Array<{ ok: true, value: R } | { ok: false, error: any }>>}
 */
export async function mapSettled(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  if (list.length === 0) return results;

  const ceiling = Math.max(1, Math.min(Number(limit) || 1, list.length));
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
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
