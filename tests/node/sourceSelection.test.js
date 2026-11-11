/**
 * `--source=` / `--free-only` selection for discover and score.
 *
 * Why this exists: the board list reached ~492 configured boards and a full
 * sweep takes ~14 minutes. Answering "what was posted in the last day that fits
 * me?" needs Adzuna only, which takes ~5 seconds — so the fast path had to stop
 * sitting behind a sweep of every Workday tenant.
 */
import { describe, it, expect } from 'vitest';

import { withSourceSelection, selectionFromArgs } from '../../src/cli/sourceSelection.js';
import { parseArgs } from '../../src/index.js';

const CONFIG = Object.freeze({
  runtime: { mode: 'DRY_RUN' },
  jobboards: {
    sources: [
      { id: 'adzuna-aggregator', adapter: 'adzuna', enabled: true },
      { id: 'ats-search', adapter: 'atsSearch', enabled: true },
      { id: 'workday-public', adapter: 'workday', enabled: true },
      { id: 'apify-scrapers', adapter: 'apify', enabled: true },
      { id: 'careers-pages', adapter: 'careers', enabled: false },
    ],
  },
});

const enabledIds = (cfg) => cfg.jobboards.sources.filter((s) => s.enabled !== false).map((s) => s.id);

describe('withSourceSelection', () => {
  it('keeps every enabled source when nothing is selected', () => {
    const { config, selected } = withSourceSelection(CONFIG, {});
    expect(enabledIds(config)).toEqual(['adzuna-aggregator', 'ats-search', 'workday-public', 'apify-scrapers']);
    expect(selected).toHaveLength(4);
  });

  it('narrows to one source by id', () => {
    const { config, selected } = withSourceSelection(CONFIG, { only: 'adzuna-aggregator' });
    expect(enabledIds(config)).toEqual(['adzuna-aggregator']);
    expect(selected).toEqual(['adzuna-aggregator']);
  });

  it('narrows by adapter name too, so the short form works', () => {
    expect(enabledIds(withSourceSelection(CONFIG, { only: 'adzuna' }).config))
      .toEqual(['adzuna-aggregator']);
  });

  it('accepts a comma-separated list', () => {
    expect(enabledIds(withSourceSelection(CONFIG, { only: 'adzuna,ats-search' }).config))
      .toEqual(['adzuna-aggregator', 'ats-search']);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(enabledIds(withSourceSelection(CONFIG, { only: ' Adzuna , ATS-Search ' }).config))
      .toEqual(['adzuna-aggregator', 'ats-search']);
  });

  it('NEVER enables a source the config disabled', () => {
    // Naming a deliberately-off board must not resurrect it — otherwise
    // `--source=careers` would quietly undo someone's decision to turn it off.
    const { config, selected } = withSourceSelection(CONFIG, { only: 'careers-pages' });
    expect(enabledIds(config)).toEqual([]);
    expect(selected).toEqual([]);
  });

  it('reports selectors that match nothing instead of silently running everything', () => {
    // A typo must not read as "no filter" and trigger a 14-minute full sweep.
    const { unmatched, config } = withSourceSelection(CONFIG, { only: 'adzuna,typoo' });
    expect(unmatched).toEqual(['typoo']);
    expect(enabledIds(config)).toEqual(['adzuna-aggregator']);
  });

  it('disables rather than drops, so skipped sources stay visible to RCA', () => {
    const { config } = withSourceSelection(CONFIG, { only: 'adzuna' });
    expect(config.jobboards.sources).toHaveLength(CONFIG.jobboards.sources.length);
    expect(config.jobboards.sources.find((s) => s.id === 'workday-public').enabled).toBe(false);
  });

  it('free-only disables metered Apify sources', () => {
    expect(enabledIds(withSourceSelection(CONFIG, { freeOnly: true }).config))
      .toEqual(['adzuna-aggregator', 'ats-search', 'workday-public']);
  });

  it('combines free-only with a selector', () => {
    expect(enabledIds(withSourceSelection(CONFIG, { only: 'apify', freeOnly: true }).config))
      .toEqual([]);
  });

  it('never mutates the input config', () => {
    withSourceSelection(CONFIG, { only: 'adzuna', freeOnly: true });
    expect(CONFIG.jobboards.sources.every((s) => s.id === 'careers-pages' || s.enabled)).toBe(true);
  });

  it('survives a config with no sources at all', () => {
    expect(() => withSourceSelection({}, { only: 'adzuna' })).not.toThrow();
    expect(withSourceSelection({}, {}).selected).toEqual([]);
  });
});

describe('selectionFromArgs', () => {
  const sel = (argv) => selectionFromArgs(parseArgs(argv));

  it('reads --source=', () => {
    expect(sel(['score', '--source=adzuna'])).toEqual({ only: 'adzuna', freeOnly: false });
  });

  it('accepts the --sources= plural spelling', () => {
    expect(sel(['score', '--sources=adzuna,ats-search']).only).toBe('adzuna,ats-search');
  });

  it('reads both spellings of the free-only flag', () => {
    expect(sel(['score', '--free-only']).freeOnly).toBe(true);
    expect(sel(['score', '--freeOnly']).freeOnly).toBe(true);
  });

  it('defaults to no selection', () => {
    expect(sel(['score'])).toEqual({ only: '', freeOnly: false });
  });
});
