import { describe, it, expect } from 'vitest';
import { scanFields, resolveFormScope } from '../../src/automation/domScanner.js';

describe('domScanner.scanFields', () => {
  it('returns [] when the page has no evaluate (unit fakes degrade gracefully)', async () => {
    expect(await scanFields(null)).toEqual([]);
    expect(await scanFields({})).toEqual([]);
    expect(await scanFields({ evaluate: 'not-a-function' })).toEqual([]);
  });

  it('returns the descriptors produced by the in-page collector', async () => {
    const fixture = [
      { kind: 'text', type: 'text', selector: '#first', label: 'First Name', name: 'first', required: true, options: [] },
      { kind: 'select', type: 'select-one', selector: '#country', label: 'Country', name: 'country', required: false,
        options: [{ label: 'United States', value: 'us' }] },
    ];
    const page = { evaluate: async () => fixture };
    expect(await scanFields(page)).toEqual(fixture);
  });

  it('returns [] when evaluate throws or yields a non-array', async () => {
    expect(await scanFields({ evaluate: async () => { throw new Error('boom'); } })).toEqual([]);
    expect(await scanFields({ evaluate: async () => ({ not: 'array' }) })).toEqual([]);
  });

  it('passes through combobox/typeahead descriptors with their listbox selector', async () => {
    const fixture = [
      { kind: 'combobox', type: 'text', selector: '#loc', label: 'Location (City)', name: 'loc', required: true, options: [], listboxSelector: '#loc-listbox' },
    ];
    const page = { evaluate: async () => fixture };
    expect(await scanFields(page)).toEqual(fixture);
  });
});

describe('domScanner.resolveFormScope', () => {
  // Build a fake frame. `parent` null => main frame; `fields` => what scanFields sees.
  const makeFrame = ({ url = '', parent = null, fields = [] }) => ({
    url: () => url,
    parentFrame: () => parent,
    evaluate: async () => fields,
  });

  it('returns the page unchanged for fakes without frames()', async () => {
    const page = { evaluate: async () => [] };
    expect(await resolveFormScope(page)).toBe(page);
    expect(await resolveFormScope(null)).toBe(null);
  });

  it('returns the page when only a main frame exists', async () => {
    const main = makeFrame({ url: 'https://job-boards.greenhouse.io/x', parent: null });
    const page = { frames: () => [main] };
    expect(await resolveFormScope(page)).toBe(page);
  });

  it('returns an embedded ATS frame that has fillable fields', async () => {
    const main = makeFrame({ url: 'https://jobs.dropbox.com/listing/1', parent: null });
    const embed = makeFrame({
      url: 'https://boards.greenhouse.io/embed/job_app?token=1',
      parent: main,
      fields: [{ kind: 'text', selector: '#first', label: 'First Name', options: [] }],
    });
    const page = { frames: () => [main, embed] };
    expect(await resolveFormScope(page)).toBe(embed);
  });

  it('ignores an ATS frame with no fields and a non-ATS child frame', async () => {
    const main = makeFrame({ url: 'https://example.com/careers', parent: null });
    const emptyAts = makeFrame({ url: 'https://greenhouse.io/embed', parent: main, fields: [] });
    const ad = makeFrame({ url: 'https://doubleclick.net/ad', parent: main, fields: [{ kind: 'text', selector: '#x', options: [] }] });
    const page = { frames: () => [main, emptyAts, ad] };
    expect(await resolveFormScope(page, { timeoutMs: 100, pollMs: 10 })).toBe(page);
  });

  // Regression: an ATS iframe that loads ASYNCHRONOUSLY used to be missed by
  // the single-pass scan, so the assistant silently fell back to the empty host
  // page and filled nothing. resolveFormScope now polls until the embed is ready.
  it('waits for an embedded ATS frame whose fields appear after a beat', async () => {
    const main = makeFrame({ url: 'https://jobs.dropbox.com/listing/1', parent: null });
    let loaded = false;
    const embed = {
      url: () => 'https://boards.greenhouse.io/embed/job_app?token=1',
      parentFrame: () => main,
      evaluate: async () => (loaded ? [{ kind: 'text', selector: '#first', label: 'First Name', options: [] }] : []),
    };
    const page = { frames: () => [main, embed] };
    setTimeout(() => { loaded = true; }, 30);
    expect(await resolveFormScope(page, { timeoutMs: 2000, pollMs: 10 })).toBe(embed);
  });

  it('waits for a child frame still on about:blank to navigate to the ATS form', async () => {
    const main = makeFrame({ url: 'https://example.com/careers', parent: null });
    let navigated = false;
    const child = {
      url: () => (navigated ? 'https://boards.greenhouse.io/embed/job_app' : 'about:blank'),
      parentFrame: () => main,
      evaluate: async () => (navigated ? [{ kind: 'text', selector: '#email', label: 'Email', options: [] }] : []),
    };
    const page = { frames: () => [main, child] };
    setTimeout(() => { navigated = true; }, 30);
    expect(await resolveFormScope(page, { timeoutMs: 2000, pollMs: 10 })).toBe(child);
  });

  it('gives up after the timeout when the embed never produces fields', async () => {
    const main = makeFrame({ url: 'https://example.com/careers', parent: null });
    const embed = makeFrame({ url: 'https://greenhouse.io/embed', parent: main, fields: [] });
    const page = { frames: () => [main, embed] };
    const started = Date.now();
    expect(await resolveFormScope(page, { timeoutMs: 80, pollMs: 10 })).toBe(page);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('returns immediately (no polling delay) for a plain top-level form page', async () => {
    const main = makeFrame({ url: 'https://example.com/apply', parent: null });
    const page = { frames: () => [main] };
    const started = Date.now();
    expect(await resolveFormScope(page)).toBe(page); // default 3s timeout NOT consumed
    expect(Date.now() - started).toBeLessThan(500);
  });
});

