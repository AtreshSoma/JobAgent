/**
 * Type-aware field filler.
 *
 * Consumes the live fields found by the DOM scanner, maps each to a value drawn
 * ONLY from the candidate profile or config screening answers (via the existing
 * prefill planner — it never invents answers), and applies that value with the
 * correct Playwright action for the control type:
 *
 *   text / email / tel / url / textarea  -> fill()
 *   select                               -> selectOption() (matched by label/value)
 *   checkbox                             -> check()/uncheck() from a yes/no value
 *   radio                                -> check() the option whose label matches
 *   combobox / typeahead                 -> type then click the matching option
 *
 * Every action is guarded (the selector must resolve to exactly one element) and
 * best-effort (failures are collected, never thrown). Unknown questions are
 * reported as "needs user" rather than guessed. This module NEVER clicks a
 * submit/continue button — navigation and submission live elsewhere and stay
 * behind the submit gate.
 */

import { buildPrefillPlan } from '../apply/formPrefill.js';

/** Truthy-ish answers that mean "tick this box". */
const AFFIRMATIVE = new Set(['yes', 'true', 'y', '1', 'agree', 'i agree', 'accept', 'checked', 'on']);

/** Count selector matches (0 on error / missing selector). */
async function safeCount(page, selector) {
  if (!selector) return 0;
  try { return await page.locator(selector).count(); } catch { return 0; }
}

/** Selectors that commonly hold the rendered options of a typeahead/combobox. */
const OPTION_SELECTORS = ['[role="option"]', '.select__option', 'li[role="option"]', '[class*="option"]'];

/**
 * After typing into a combobox/typeahead, pick the dropdown option that best
 * matches `value`. Returns the action taken or an error. Best-effort: tries the
 * common option containers, prefers an exact (then substring) text match, and
 * falls back to committing the highlighted option with Enter.
 */
async function pickComboboxOption(page, field, value) {
  const want = String(value ?? '').trim().toLowerCase();
  const scope = field.listboxSelector ? `${field.listboxSelector} ` : '';

  for (const base of OPTION_SELECTORS) {
    const sel = `${scope}${base}`;
    let count = 0;
    try { count = await page.locator(sel).count(); } catch { count = 0; }
    if (!count) continue;

    let texts = [];
    try { texts = await page.locator(sel).allTextContents(); } catch { texts = []; }
    const norm = texts.map((t) => String(t ?? '').trim().toLowerCase());
    let idx = norm.findIndex((t) => t === want);
    if (idx < 0) idx = norm.findIndex((t) => t && (t.includes(want) || want.includes(t)));
    if (idx < 0) idx = 0; // typeahead already filtered by what we typed -> top match

    try {
      await page.locator(sel).nth(idx).click();
      return { ok: true, action: 'combobox' };
    } catch { /* try the next container shape */ }
  }

  // Nothing clickable found: commit the highlighted option via keyboard.
  if (page.keyboard && typeof page.keyboard.press === 'function') {
    try { await page.keyboard.press('Enter'); return { ok: true, action: 'combobox-enter' }; }
    catch { /* fall through */ }
  }
  return { ok: false, action: 'combobox', error: 'no matching option appeared' };
}

/** Find the option whose label or value best matches `value` (case-insensitive). */
export function matchOption(options = [], value) {
  if (!Array.isArray(options) || options.length === 0) return null;
  const want = String(value ?? '').trim().toLowerCase();
  if (!want) return null;
  // 1. exact label / value
  let hit = options.find((o) => String(o.label ?? '').trim().toLowerCase() === want)
    || options.find((o) => String(o.value ?? '').trim().toLowerCase() === want);
  if (hit) return hit;
  // 2. substring either direction
  hit = options.find((o) => {
    const lab = String(o.label ?? '').trim().toLowerCase();
    return lab && (lab.includes(want) || want.includes(lab));
  });
  return hit ?? null;
}

/**
 * Apply a single value to a scanned field with the right control action.
 *
 * @param {object} page Playwright page (or fake)
 * @param {object} field scanned field descriptor (see domScanner.scanFields)
 * @param {string} value value to apply
 * @returns {Promise<{ok: boolean, action: string, error?: string}>}
 */
export async function applyValue(page, field, value) {
  const kind = field.kind ?? field.type ?? 'text';
  try {
    if (kind === 'select') {
      const opt = matchOption(field.options, value);
      if (!opt) return { ok: false, action: 'select', error: `no option matches "${value}"` };
      if ((await safeCount(page, field.selector)) !== 1) return { ok: false, action: 'select', error: 'selector not unique' };
      // Prefer matching by value, fall back to label.
      try { await page.locator(field.selector).first().selectOption(opt.value); }
      catch { await page.locator(field.selector).first().selectOption({ label: opt.label }); }
      return { ok: true, action: 'select' };
    }

    if (kind === 'checkbox') {
      if ((await safeCount(page, field.selector)) !== 1) return { ok: false, action: 'checkbox', error: 'selector not unique' };
      const on = AFFIRMATIVE.has(String(value ?? '').trim().toLowerCase());
      const loc = page.locator(field.selector).first();
      if (on) { await (loc.check?.() ?? loc.click()); }
      else if (loc.uncheck) { await loc.uncheck(); }
      return { ok: true, action: on ? 'check' : 'uncheck' };
    }

    if (kind === 'radio') {
      const opt = matchOption(field.options, value);
      if (!opt || !opt.selector) return { ok: false, action: 'radio', error: `no option matches "${value}"` };
      if ((await safeCount(page, opt.selector)) !== 1) return { ok: false, action: 'radio', error: 'option not unique' };
      const loc = page.locator(opt.selector).first();
      await (loc.check?.() ?? loc.click());
      return { ok: true, action: 'radio' };
    }

    if (kind === 'combobox') {
      if ((await safeCount(page, field.selector)) !== 1) return { ok: false, action: 'combobox', error: 'selector not unique' };
      const input = page.locator(field.selector).first();
      // Open the widget, type the value (react-select listens on input events),
      // then commit a matching option from the dropdown.
      try { await input.click?.(); } catch { /* best effort */ }
      await input.fill(String(value));
      return pickComboboxOption(page, field, value);
    }

    // text-like + textarea
    if ((await safeCount(page, field.selector)) !== 1) return { ok: false, action: 'fill', error: 'selector not unique' };
    await page.locator(field.selector).first().fill(String(value));
    return { ok: true, action: 'fill' };
  } catch (err) {
    return { ok: false, action: kind, error: err.message };
  }
}

/**
 * Plan + fill every scanned field that has a confident, profile/config-backed
 * value. Skips any selector already filled by an earlier pass.
 *
 * @param {object} page
 * @param {Array<object>} scannedFields from scanFields()
 * @param {object} ctx
 * @param {object} ctx.candidate candidate config
 * @param {object} ctx.screeningAnswers screening config
 * @param {Set<string>} [ctx.alreadyFilled] selectors already handled
 * @returns {Promise<{filled: object[], needsUser: object[], errors: object[]}>}
 */
export async function fillScannedFields(page, scannedFields = [], { candidate, screeningAnswers, alreadyFilled = new Set() } = {}) {
  // Feed the existing deterministic planner (label -> value + source).
  const planInput = scannedFields.map((f) => ({
    label: f.label,
    selector: f.selector,
    choices: (f.options ?? []).map((o) => o.label ?? o.value).filter(Boolean),
  }));
  const { plan, needsUser } = buildPrefillPlan(planInput, { candidate, screeningAnswers });

  // Annotate each unanswerable field with whether the live form marks it
  // REQUIRED. The assistant stops only for required unknowns; optional ones
  // (e.g. middle name, address line 2, "decline to answer" EEO selects) are
  // simply left blank so the run can still advance.
  const needsUserAnnotated = needsUser.map((nu) => {
    const f = scannedFields.find(
      (s) => s.label === nu.label && (s.selector ?? null) === (nu.selector ?? null),
    );
    return { ...nu, required: f?.required === true, kind: f?.kind };
  });

  const filled = [];
  const errors = [];
  for (const entry of plan) {
    const field = scannedFields.find((f) => f.label === entry.label && (f.selector ?? null) === (entry.selector ?? null));
    if (!field) continue;
    const key = field.selector ?? `${field.kind}:${field.name}`;
    if (alreadyFilled.has(key)) continue;
    const res = await applyValue(page, field, entry.value);
    if (res.ok) {
      alreadyFilled.add(key);
      filled.push({ field: entry.field, label: entry.label, selector: field.selector, source: entry.source, action: res.action });
    } else if (res.error) {
      errors.push({ field: entry.field, label: entry.label, selector: field.selector, error: res.error });
    }
  }
  return { filled, needsUser: needsUserAnnotated, errors };
}
