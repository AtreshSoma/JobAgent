import { describe, it, expect } from 'vitest';
import {
  ADVANCE_RE, SUBMIT_RE, findAdvanceControl, findSubmitControl, clickAndSettle,
} from '../../src/automation/navigator.js';

describe('navigator regexes', () => {
  it('ADVANCE_RE matches forward controls but not the final submit', () => {
    for (const t of ['Next', 'Continue', 'Save and continue', 'Review', 'Proceed', 'Next step']) {
      expect(ADVANCE_RE.test(t)).toBe(true);
    }
    expect(SUBMIT_RE.test('Submit application')).toBe(true);
    expect(SUBMIT_RE.test('Finish')).toBe(true);
  });
});

function pageWith(clickables) {
  return { evaluate: async () => clickables };
}

describe('navigator.findAdvanceControl', () => {
  it('returns the first advance control, skipping submit-like text', async () => {
    const page = pageWith([
      { text: 'Submit application', selector: '#submit' },
      { text: 'Continue', selector: '#next' },
    ]);
    expect(await findAdvanceControl(page)).toEqual({ text: 'Continue', selector: '#next' });
  });

  it('returns null when there is no evaluate (fake page degrades)', async () => {
    expect(await findAdvanceControl({})).toBeNull();
  });

  it('returns null when only a submit is present', async () => {
    const page = pageWith([{ text: 'Submit', selector: '#s' }]);
    expect(await findAdvanceControl(page)).toBeNull();
  });
});

describe('navigator.findSubmitControl', () => {
  it('finds a submit control that has a selector', async () => {
    const page = pageWith([
      { text: 'Continue', selector: '#next' },
      { text: 'Submit application', selector: '#submit' },
    ]);
    expect(await findSubmitControl(page)).toEqual({ text: 'Submit application', selector: '#submit' });
  });
});

describe('navigator.clickAndSettle', () => {
  function makePage({ count = 1 } = {}) {
    const calls = [];
    return {
      calls,
      locator: (selector) => ({
        count: async () => count,
        first: () => ({ click: async () => calls.push({ selector, action: 'click' }) }),
      }),
    };
  }

  it('clicks a unique selector and awaits the injected settle hook', async () => {
    const page = makePage();
    let waited = false;
    const ok = await clickAndSettle(page, { selector: '#next', text: 'Continue' }, { wait: async () => { waited = true; } });
    expect(ok).toBe(true);
    expect(waited).toBe(true);
    expect(page.calls).toContainEqual({ selector: '#next', action: 'click' });
  });

  it('returns false for a null control', async () => {
    expect(await clickAndSettle(makePage(), null, { wait: async () => {} })).toBe(false);
  });

  it('falls back to getByRole when the selector is not unique', async () => {
    const calls = [];
    const page = {
      locator: () => ({ count: async () => 0, first: () => ({ click: async () => {} }) }),
      getByRole: (role, opts) => ({ first: () => ({ click: async () => calls.push({ role, name: opts.name }) }) }),
    };
    const ok = await clickAndSettle(page, { selector: '#dup', text: 'Continue' }, { wait: async () => {} });
    expect(ok).toBe(true);
    expect(calls).toContainEqual({ role: 'button', name: 'Continue' });
  });
});
