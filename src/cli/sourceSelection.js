/**
 * Narrow which discovery sources a run uses, from CLI flags.
 *
 * Why this exists
 * ---------------
 * The board list grew to ~492 configured boards, and a full sweep takes about
 * 14 minutes. That is the right cost for a daily "find everything" run, and the
 * wrong cost for the question people actually ask most often — "what was posted
 * in the last day that fits me?" Adzuna alone answers that in about 5 seconds
 * (measured: 257 on-target postings under 24h old), so forcing it to sit behind
 * a 14-minute sweep of every Workday tenant made the fast path unusable.
 *
 * Selection is by source `id` OR by `adapter`, so both of these work and mean
 * the same thing when only one Adzuna source is configured:
 *
 *   npm run score -- --source=adzuna-aggregator
 *   npm run score -- --source=adzuna
 *
 * Nothing here ENABLES a source that the config disables — a selector only ever
 * narrows. That keeps `--source` from silently resurrecting a board someone
 * turned off deliberately (a disabled Apify source must stay off even if you
 * name it).
 */

/**
 * Apply source selection / free-only to a loaded config.
 *
 * @param {object} config loaded config object
 * @param {object} [opts]
 * @param {string|string[]} [opts.only] comma-separated ids/adapters to keep
 * @param {boolean} [opts.freeOnly] disable metered (Apify) sources
 * @returns {{ config: object, selected: string[], unmatched: string[] }}
 *   `config` is a new object — the input is never mutated.
 */
export function withSourceSelection(config, { only, freeOnly } = {}) {
  const sources = config?.jobboards?.sources ?? [];

  const wanted = (Array.isArray(only) ? only : String(only ?? '').split(','))
    .map((s) => String(s ?? '').trim().toLowerCase())
    .filter(Boolean);

  let next = sources;

  if (freeOnly === true) {
    next = next.map((s) => (s.adapter === 'apify' ? { ...s, enabled: false } : s));
  }

  const unmatched = [];
  if (wanted.length) {
    const matches = (s) => {
      const id = String(s.id ?? '').toLowerCase();
      const adapter = String(s.adapter ?? '').toLowerCase();
      return wanted.includes(id) || wanted.includes(adapter);
    };
    for (const w of wanted) {
      if (!sources.some((s) => String(s.id ?? '').toLowerCase() === w
        || String(s.adapter ?? '').toLowerCase() === w)) unmatched.push(w);
    }
    // Disable rather than drop: downstream code and RCA reporting still see the
    // full source list, so a skipped source is visibly skipped, not missing.
    next = next.map((s) => (matches(s) ? s : { ...s, enabled: false }));
  }

  const selected = next.filter((s) => s.enabled !== false).map((s) => s.id ?? s.adapter);
  return {
    config: { ...config, jobboards: { ...config.jobboards, sources: next } },
    selected,
    unmatched,
  };
}

/**
 * Read the selection flags off a parsed argv object.
 * @param {{ flags: Set<string>, options: Record<string, string> }} parsed
 */
export function selectionFromArgs(parsed = {}) {
  const flags = parsed.flags ?? new Set();
  return {
    only: parsed.options?.source ?? parsed.options?.sources ?? '',
    freeOnly: flags.has('free-only') || flags.has('freeOnly'),
  };
}
