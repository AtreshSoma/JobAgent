import { describe, it, expect } from 'vitest';
import { matchOption, applyValue, fillScannedFields } from '../../src/automation/fieldFiller.js';

/**
 * Minimal fake Playwright page. Each selector resolves to a recording locator.
 * `counts` lets a test force a non-unique (0 or 2) match for a selector.
 */
function makePage({ counts = {} } = {}) {
  const calls = [];
  const locatorFor = (selector) => {
    const node = {
      selectOption: async (arg) => { calls.push({ selector, action: 'selectOption', arg }); },
      check: async () => { calls.push({ selector, action: 'check' }); },
      uncheck: async () => { calls.push({ selector, action: 'uncheck' }); },
      fill: async (value) => { calls.push({ selector, action: 'fill', value }); },
      click: async () => { calls.push({ selector, action: 'click' }); },
    };
    return {
      count: async () => (selector in counts ? counts[selector] : 1),
      first: () => node,
    };
  };
  return { calls, locator: locatorFor };
}

describe('fieldFiller.matchOption', () => {
  const options = [
    { label: 'United States', value: 'us' },
    { label: 'Canada', value: 'ca' },
  ];
  it('matches by exact label then exact value (case-insensitive)', () => {
    expect(matchOption(options, 'united states')).toEqual({ label: 'United States', value: 'us' });
    expect(matchOption(options, 'CA')).toEqual({ label: 'Canada', value: 'ca' });
  });
  it('falls back to substring matching either direction', () => {
    expect(matchOption(options, 'United')).toEqual({ label: 'United States', value: 'us' });
  });
  it('returns null for empty input or no match', () => {
    expect(matchOption([], 'x')).toBeNull();
    expect(matchOption(options, '')).toBeNull();
    expect(matchOption(options, 'mexico')).toBeNull();
  });
});

describe('fieldFiller.applyValue', () => {
  it('fills text inputs', async () => {
    const page = makePage();
    const res = await applyValue(page, { kind: 'text', selector: '#name' }, 'Ada');
    expect(res).toEqual({ ok: true, action: 'fill' });
    expect(page.calls).toContainEqual({ selector: '#name', action: 'fill', value: 'Ada' });
  });

  it('selects an option by value', async () => {
    const page = makePage();
    const field = { kind: 'select', selector: '#country', options: [{ label: 'United States', value: 'us' }] };
    const res = await applyValue(page, field, 'United States');
    expect(res.ok).toBe(true);
    expect(page.calls).toContainEqual({ selector: '#country', action: 'selectOption', arg: 'us' });
  });

  it('checks a checkbox for affirmative values and unchecks otherwise', async () => {
    const page = makePage();
    expect((await applyValue(page, { kind: 'checkbox', selector: '#agree' }, 'yes')).action).toBe('check');
    expect((await applyValue(page, { kind: 'checkbox', selector: '#agree' }, 'no')).action).toBe('uncheck');
    expect(page.calls).toContainEqual({ selector: '#agree', action: 'check' });
    expect(page.calls).toContainEqual({ selector: '#agree', action: 'uncheck' });
  });

  it('checks the matching radio option', async () => {
    const page = makePage();
    const field = { kind: 'radio', selector: '#auth', options: [
      { label: 'Yes', value: 'y', selector: '#auth-yes' },
      { label: 'No', value: 'n', selector: '#auth-no' },
    ] };
    const res = await applyValue(page, field, 'Yes');
    expect(res).toEqual({ ok: true, action: 'radio' });
    expect(page.calls).toContainEqual({ selector: '#auth-yes', action: 'check' });
  });

  it('refuses to act when the selector is not unique', async () => {
    const page = makePage({ counts: { '#dup': 2 } });
    const res = await applyValue(page, { kind: 'text', selector: '#dup' }, 'x');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not unique/);
    expect(page.calls).toHaveLength(0);
  });

  it('reports when no select option matches', async () => {
    const page = makePage();
    const field = { kind: 'select', selector: '#c', options: [{ label: 'A', value: 'a' }] };
    const res = await applyValue(page, field, 'zzz');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no option matches/);
  });
});

/**
 * Fake page for combobox/typeahead widgets. The input selector resolves to a
 * unique recording node; option selectors resolve to a configurable list whose
 * `nth(i).click()` is recorded. `keyboard.press` is recorded when present.
 */
function makeComboboxPage({ inputSelector = '#loc', optionMap = {}, keyboard = false } = {}) {
  const calls = [];
  const locator = (selector) => {
    const node = {
      click: async () => { calls.push({ selector, action: 'click' }); },
      fill: async (value) => { calls.push({ selector, action: 'fill', value }); },
    };
    const options = optionMap[selector] || null;
    return {
      count: async () => (selector === inputSelector ? 1 : (options ? options.length : 0)),
      first: () => node,
      allTextContents: async () => options || [],
      nth: (i) => ({ click: async () => { calls.push({ selector, action: 'optionClick', index: i, text: (options || [])[i] }); } }),
    };
  };
  const page = { calls, locator };
  if (keyboard) page.keyboard = { press: async (key) => { calls.push({ action: 'press', key }); } };
  return page;
}

describe('fieldFiller.applyValue (combobox/typeahead)', () => {
  it('types the value and clicks the best-matching option', async () => {
    const page = makeComboboxPage({
      inputSelector: '#loc',
      optionMap: { '[role="option"]': ['Morrisville, NC, USA', 'Morristown, NJ, USA'] },
    });
    const res = await applyValue(page, { kind: 'combobox', selector: '#loc' }, 'Morrisville');
    expect(res).toEqual({ ok: true, action: 'combobox' });
    expect(page.calls).toContainEqual({ selector: '#loc', action: 'fill', value: 'Morrisville' });
    expect(page.calls).toContainEqual({ selector: '[role="option"]', action: 'optionClick', index: 0, text: 'Morrisville, NC, USA' });
  });

  it('scopes option lookup to the listbox when known', async () => {
    const page = makeComboboxPage({
      inputSelector: '#loc',
      optionMap: { '#lb [role="option"]': ['Remote', 'Onsite'] },
    });
    const field = { kind: 'combobox', selector: '#loc', listboxSelector: '#lb' };
    const res = await applyValue(page, field, 'Remote');
    expect(res.ok).toBe(true);
    expect(page.calls).toContainEqual({ selector: '#lb [role="option"]', action: 'optionClick', index: 0, text: 'Remote' });
  });

  it('falls back to Enter when no option container renders', async () => {
    const page = makeComboboxPage({ inputSelector: '#loc', optionMap: {}, keyboard: true });
    const res = await applyValue(page, { kind: 'combobox', selector: '#loc' }, 'Anything');
    expect(res).toEqual({ ok: true, action: 'combobox-enter' });
    expect(page.calls).toContainEqual({ action: 'press', key: 'Enter' });
  });

  it('reports an error when no option appears and no keyboard fallback exists', async () => {
    const page = makeComboboxPage({ inputSelector: '#loc', optionMap: {} });
    const res = await applyValue(page, { kind: 'combobox', selector: '#loc' }, 'x');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no matching option/);
  });

  it('refuses to act when the combobox selector is not unique', async () => {
    const page = makeComboboxPage({ inputSelector: '#other' });
    const res = await applyValue(page, { kind: 'combobox', selector: '#loc' }, 'x');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not unique/);
  });
});

describe('fieldFiller.fillScannedFields', () => {
  const candidate = { identity: { fullName: 'Ada Lovelace' }, contact: { email: 'ada@x.io' } };

  it('fills profile-backed fields and skips ones already filled', async () => {
    const page = makePage();
    const scanned = [
      { kind: 'text', type: 'text', selector: '#first', label: 'First Name', name: 'first', options: [] },
      { kind: 'text', type: 'email', selector: '#email', label: 'Email', name: 'email', options: [] },
    ];
    const alreadyFilled = new Set(['#email']);
    const res = await fillScannedFields(page, scanned, { candidate, screeningAnswers: {}, alreadyFilled });
    const filledSelectors = res.filled.map((f) => f.selector);
    expect(filledSelectors).toContain('#first');
    expect(filledSelectors).not.toContain('#email');
    expect(alreadyFilled.has('#first')).toBe(true);
    expect(page.calls).toContainEqual({ selector: '#first', action: 'fill', value: 'Ada' });
  });

  it('reports unknown questions as needsUser rather than guessing', async () => {
    const page = makePage();
    const scanned = [
      { kind: 'text', type: 'text', selector: '#q', label: 'What is your favorite color?', name: 'q', options: [] },
    ];
    const res = await fillScannedFields(page, scanned, { candidate, screeningAnswers: {} });
    expect(res.needsUser.length).toBe(1);
    expect(res.filled.length).toBe(0);
  });

  it('fills a combobox location field by typing then selecting an option', async () => {
    const page = makeComboboxPage({
      inputSelector: '#loc',
      optionMap: { '[role="option"]': ['Morrisville, NC, USA'] },
    });
    const cand = { identity: { fullName: 'Ada Lovelace' }, contact: {}, location: { city: 'Morrisville' } };
    const scanned = [
      { kind: 'combobox', type: 'text', selector: '#loc', label: 'Location (City)', name: 'loc', options: [] },
    ];
    const res = await fillScannedFields(page, scanned, { candidate: cand, screeningAnswers: {} });
    expect(res.filled.map((f) => f.selector)).toContain('#loc');
    expect(page.calls).toContainEqual({ selector: '#loc', action: 'fill', value: 'Morrisville' });
    expect(page.calls).toContainEqual({ selector: '[role="option"]', action: 'optionClick', index: 0, text: 'Morrisville, NC, USA' });
  });
});
