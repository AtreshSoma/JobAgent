/**
 * Multi-step form navigator.
 *
 * Many application flows span several pages: fill page 1, click "Next" /
 * "Continue", fill page 2, and so on until a final "Submit". This module finds
 * the control that advances to the next step (NOT the final submit) and clicks
 * it, then waits for the next step to settle. It also helps locate a final
 * submit control when the packet's static selector is absent.
 *
 * It is intentionally conservative:
 *   - "Advance" buttons (Next/Continue/Review) move forward; they are safe.
 *   - "Submit/Finish" controls are reported separately and are NEVER clicked
 *     here — the only path to a submit is the pure submit gate in applyRunner.
 *   - All DOM reads happen via `page.evaluate`; with no `evaluate` (unit fakes)
 *     the finders return null so the caller degrades to single-page behavior.
 */

/** Text that means "go to the next step" (forward, not final). */
export const ADVANCE_RE = /\b(next|continue|proceed|review|save\s*(?:and|&)\s*continue|next\s*step|go\s*to\s*next)\b/i;

/**
 * Text that opens/starts an application from a JD landing page. NOT a general
 * advance control: on one-page/quick-apply flows "Apply now" IS the final
 * submit, so these are only clicked on a page with no form fields at all
 * (a pure landing page) — never on a page we just filled.
 */
export const APPLY_START_RE = /\b(start\s*application|apply\s*now|apply\s*for\s*this\s*job)\b/i;

/** Text that means "this is the FINAL submit" — never auto-clicked by the navigator. */
export const SUBMIT_RE = /\b(submit|finish|send\s*application|complete\s*application|submit\s*application)\b/i;

/* c8 ignore start - executes in the browser, not under node coverage */
function collectClickables() {
  const cssEscape = (s) =>
    (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));

  const isVisible = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const selectorFor = (el) => {
    if (el.id) return `#${cssEscape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.name) {
      if (type) return `${tag}[name="${cssEscape(el.name)}"][type="${type}"]`;
      return `${tag}[name="${cssEscape(el.name)}"]`;
    }
    if (type === 'submit' || type === 'button') return `${tag}[type="${type}"]`;
    return null;
  };

  const nodes = Array.from(document.querySelectorAll(
    'button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]',
  ));
  const out = [];
  for (const el of nodes) {
    if (el.disabled) continue;
    if (!isVisible(el)) continue;
    const text = (el.value || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({ text, selector: selectorFor(el) });
    if (out.length >= 60) break;
  }
  return out;
}
/* c8 ignore stop */

async function collect(page) {
  if (!page || typeof page.evaluate !== 'function') return [];
  try {
    const list = await page.evaluate(collectClickables);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Find the control that advances to the next step (forward, not final submit).
 *
 * @param {object} page
 * @param {object} [options]
 * @param {boolean} [options.allowApplyStart=false] also accept "Apply now" /
 *   "Start application" — pass true ONLY on a fieldless JD landing page, where
 *   such a button opens the form (on a filled one-page form it IS the submit).
 * @returns {Promise<{selector: string|null, text: string}|null>}
 */
export async function findAdvanceControl(page, { allowApplyStart = false } = {}) {
  const list = await collect(page);
  for (const c of list) {
    if (SUBMIT_RE.test(c.text)) continue; // never treat a final submit as "advance"
    if (ADVANCE_RE.test(c.text)) return c;
    if (allowApplyStart && APPLY_START_RE.test(c.text)) return c;
  }
  return null;
}

/**
 * Find a final submit control on the page (for when the packet has none).
 * @param {object} page
 * @returns {Promise<{selector: string|null, text: string}|null>}
 */
export async function findSubmitControl(page) {
  const list = await collect(page);
  const hit = list.find((c) => SUBMIT_RE.test(c.text) && c.selector);
  return hit ?? null;
}

/**
 * Click a control and wait for the next step to settle.
 *
 * @param {object} page
 * @param {{selector: string|null, text: string}} control
 * @param {object} [deps]
 * @param {Function} [deps.wait] async settle hook (default: load-state + 400ms)
 * @param {object} [options]
 * @param {boolean} [options.selectorOnly=false] forbid the accessible-name
 *   fallback. Set for the FINAL submit: the runner earns the right to click only
 *   after verifying that one specific selector resolves to exactly one element.
 *   If the DOM changed since that check, falling back to "any button named
 *   Submit" could click a different form's submit, so we refuse and let the
 *   human finish instead.
 * @returns {Promise<boolean>} true if the click was issued
 */
export async function clickAndSettle(page, control, deps = {}, options = {}) {
  if (!control) return false;
  let loc;
  if (control.selector) {
    try { if ((await page.locator(control.selector).count()) !== 1) loc = null; else loc = page.locator(control.selector).first(); }
    catch { loc = null; }
  }
  if (!loc && options.selectorOnly === true) return false;
  // The name fallback may never reach a submit. A submit-named control must
  // earn a unique selector (see selectorOnly), and the match is EXACT: by
  // default Playwright matches the name as a case-insensitive SUBSTRING, so
  // a "Review" step resolved to a "Review and Submit" button and submitted.
  if (!loc && typeof page.getByRole === 'function' && control.text && !SUBMIT_RE.test(control.text)) {
    try { loc = page.getByRole('button', { name: control.text, exact: true }).first(); } catch { loc = null; }
  }
  if (!loc) return false;

  try {
    await loc.click();
  } catch {
    return false;
  }

  if (typeof deps.wait === 'function') {
    await deps.wait(page);
  } else {
    try { await page.waitForLoadState?.('domcontentloaded', { timeout: 15000 }); } catch { /* ignore */ }
    try { await page.waitForLoadState?.('networkidle', { timeout: 8000 }); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return true;
}
