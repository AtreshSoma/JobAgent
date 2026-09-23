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
import {
  contradictingSponsorshipClaim, isInvertedSponsorshipQuestion, isSponsorshipTopic,
} from '../apply/screeningQA.js';
import { wholeWordIn } from '../utils/textNormalize.js';

/**
 * Questions whose answer is a legal, immigration or demographic statement.
 *
 * For these a WRONG choice is worse than no choice, so a typeahead may never
 * commit "whatever is on top" or press Enter on its highlighted row. Measured
 * before this guard: for "Will you now or in the future require sponsorship?"
 * the filler typed "Yes", nothing matched, the top-option fallback fired, and
 * it clicked "I am authorized to work and will not require sponsorship" — for
 * a candidate who requires it.
 */
export const SENSITIVE_CHOICE_LABEL = /\b(sponsor\w*|visas?|authori[sz]\w*|legally|citizen\w*|clearance|consent\w*|acknowledg\w*|certif\w*|attest\w*|eeo\w*|veteran\w*|disabilit\w*|gender|race|ethnic\w*)\b/i;

/** Is this a field where only an exact, whole-word option match may be committed? */
export function isSensitiveChoiceLabel(label) {
  return SENSITIVE_CHOICE_LABEL.test(String(label ?? ''));
}

/** Truthy-ish answers that mean "tick this box". */
const AFFIRMATIVE = new Set(['yes', 'true', 'y', '1', 'agree', 'i agree', 'accept', 'checked', 'on']);
const BINARY_QUESTION = /\b(sponsor(?:ship)?|visa|work authorization|legally authorized|consent|agree|acknowledge|background check)\b/i;

/**
 * Choice widgets need the option token, not a truthful explanatory sentence.
 * Example: "Yes. I currently hold H-1B..." must become "Yes" for a Yes/No
 * sponsorship select. Free-text fields retain the full configured answer.
 */
export function normalizeChoiceValue(field = {}, value) {
  const kind = field.kind ?? field.type ?? 'text';
  if (!['select', 'radio', 'combobox', 'checkbox'].includes(kind)) return value;
  if (!BINARY_QUESTION.test(String(field.label ?? ''))) return value;
  const raw = String(value ?? '').trim();
  const polarity = /^yes\b/i.test(raw) ? 'yes' : /^no\b/i.test(raw) ? 'no' : null;
  if (!polarity) return value;
  const option = (field.options ?? []).find((candidate) => {
    const label = String(candidate.label ?? candidate.value ?? '').trim();
    return polarity === 'yes' ? /^(yes|y)\b/i.test(label) : /^(no|n)\b/i.test(label);
  });
  return option?.label ?? option?.value ?? (polarity === 'yes' ? 'Yes' : 'No');
}

/** Count selector matches (0 on error / missing selector). */
async function safeCount(page, selector) {
  if (!selector) return 0;
  try { return await page.locator(selector).count(); } catch { return 0; }
}

/** Selectors that commonly hold the rendered options of a typeahead/combobox. */
const OPTION_SELECTORS = ['[role="option"]', '.select__option', 'li[role="option"]', '[class*="option"]'];

/**
 * Longest typed value we trust a typeahead to have filtered for us. A short
 * value (a city, "Yes", "Remote") may legitimately commit the highlighted/top
 * option even without a textual match. A long sentence value never should — if
 * nothing matches we report the field unfilled rather than click a random first
 * option (that is how the wrong choice slipped into an acknowledgement dropdown).
 */
const MAX_COMBOBOX_AUTOPICK = 40;

/**
 * After typing into a combobox/typeahead, pick the dropdown option that best
 * matches `value`. Returns the action taken or an error. Best-effort: tries the
 * common option containers, prefers an exact (then substring) text match, and
 * only commits the highlighted/top option for SHORT typed values.
 */
async function pickComboboxOption(page, field, value) {
  const want = String(value ?? '').trim().toLowerCase();
  // Never "trust the top result" for a legal/immigration/demographic question;
  // see SENSITIVE_CHOICE_LABEL.
  const sensitive = isSensitiveChoiceLabel(field.label);
  const allowTopMatch = !sensitive && want.length > 0 && want.length <= MAX_COMBOBOX_AUTOPICK;
  const scope = field.listboxSelector ? `${field.listboxSelector} ` : '';

  for (const base of OPTION_SELECTORS) {
    const sel = `${scope}${base}`;
    let count;
    try { count = await page.locator(sel).count(); } catch { count = 0; }
    if (!count) continue;

    let texts;
    try { texts = await page.locator(sel).allTextContents(); } catch { texts = []; }
    const norm = texts.map((t) => String(t ?? '').trim().toLowerCase());
    let idx = norm.findIndex((t) => t === want);
    // Option text contains what we typed — as a WHOLE WORD. A raw substring
    // test let "no" match inside "will NOT require sponsorship" and inside
    // "NOW or in the future", which is how a typed "No" picked the opposite
    // immigration answer.
    if (idx < 0) idx = norm.findIndex((t) => t && wholeWordIn(t, want));
    // What we typed contains the option text — but only as a WHOLE WORD, so a
    // two-letter option like "No" can never match inside "ack-no-wledge".
    if (idx < 0) idx = norm.findIndex((t) => t && wholeWordIn(want, t));
    // No textual match: only trust the typeahead's top result for short values.
    if (idx < 0 && allowTopMatch) idx = 0;
    if (idx < 0) return { ok: false, action: 'combobox', error: `no option matches "${value}"` };

    try {
      await page.locator(sel).nth(idx).click();
      return { ok: true, action: 'combobox', chosen: String(texts[idx] ?? '').trim() || null };
    } catch { /* try the next container shape */ }
  }

  // Nothing clickable found: commit the highlighted option via keyboard — but
  // only for short values (never blindly commit after a long/sentence value),
  // and never on a sensitive question, where the highlighted row is unknown.
  if (allowTopMatch && page.keyboard && typeof page.keyboard.press === 'function') {
    try { await page.keyboard.press('Enter'); return { ok: true, action: 'combobox-enter', chosen: null }; }
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
  // 2. option label contains the wanted value, OR the wanted value contains the
  //    label as a WHOLE WORD (so a 2-letter option like "No" never matches
  //    inside an unrelated word such as "acknowledge").
  //    Whole words BOTH ways: `lab.includes(want)` matched "no" inside "not",
  //    so "No" selected "I am authorized and will not require sponsorship".
  hit = options.find((o) => {
    const lab = String(o.label ?? '').trim().toLowerCase();
    return lab && (wholeWordIn(lab, want) || wholeWordIn(want, lab));
  });
  return hit ?? null;
}

/** "yes" / "no" for an answer or option that leads with one, else null. */
function polarityOf(text) {
  const t = String(text ?? '').trim();
  if (/^(yes|y)\b/i.test(t)) return 'yes';
  if (/^(no|n)\b/i.test(t)) return 'no';
  return null;
}

/**
 * Does the option that was actually COMMITTED contradict what we meant to say
 * on a sponsorship / work-authorization question?
 *
 * Matching decides which option to click; this reads back what the widget
 * ended up showing and judges THAT, because the two can differ (a typeahead
 * re-sorting on input, a react-select committing its highlighted row). Three
 * independent checks, any one of which refuses:
 *   1. an inverted question ("…without sponsorship?") is never auto-answered;
 *   2. the chosen text asserts the opposite of the candidate's stated need
 *      (`contradictingSponsorshipClaim`);
 *   3. we meant "No" and the widget says "Yes" (or vice versa).
 *
 * @param {object} args
 * @param {string} args.label question text
 * @param {string} args.intended value we tried to commit
 * @param {string|null} args.chosen option text read back from the widget
 * @param {boolean|null|undefined} args.requiresSponsorship the candidate's real need
 * @returns {string|null} the reason to refuse, or null when consistent
 */
export function sponsorshipChoiceConflict({ label, intended, chosen, requiresSponsorship } = {}) {
  if (!isSponsorshipTopic(label)) return null;
  if (isInvertedSponsorshipQuestion(label)) {
    return 'inverted sponsorship question — it must be answered by you';
  }
  if (chosen == null || !String(chosen).trim()) {
    return 'the selected option could not be read back to confirm it';
  }
  const claim = contradictingSponsorshipClaim(chosen, requiresSponsorship);
  if (claim) return `the selected option "${String(chosen).trim()}" states "${claim}", which contradicts your profile`;
  const want = polarityOf(intended);
  const got = polarityOf(chosen);
  if (want && got && want !== got) {
    return `the selected option "${String(chosen).trim()}" is the opposite of the intended "${String(intended).trim()}"`;
  }
  return null;
}

/**
 * Text of the option a choice widget is showing now, or `fallback`.
 * Real Playwright locators expose `evaluate`; page doubles fall back to the
 * option text we clicked.
 */
async function readBackChoice(locator, kind, fallback) {
  if (!locator || typeof locator.evaluate !== 'function') return fallback ?? null;
  try {
    const text = await locator.evaluate((el, k) => {
      if (k === 'select') return el.selectedOptions?.[0]?.textContent ?? '';
      if (k === 'radio') {
        if (!el.checked) return '';
        const lab = (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label');
        return (lab?.textContent ?? el.value ?? '');
      }
      // react-select and friends render the committed value next to the input.
      const box = el.closest('[class*="select__control"], [class*="-control"], [class*="container"], [role="combobox"]')
        ?? el.parentElement;
      const single = box?.querySelector?.('[class*="single-value"], [class*="singleValue"], [class*="selected"]');
      return single?.textContent ?? el.value ?? '';
    }, kind);
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    return clean || fallback || null;
  } catch {
    return fallback ?? null;
  }
}

/** Undo a refused choice as far as the widget allows (best effort). */
async function clearChoice(kind, locator) {
  try {
    if (kind === 'select') {
      try { await locator.selectOption(''); } catch { await locator.selectOption({ index: 0 }); }
    } else if (kind === 'combobox') {
      await locator.fill?.('');
      await locator.press?.('Backspace');
    }
    // A radio group cannot be un-checked; the blocker the caller records keeps
    // the run from ever advancing or submitting past it.
  } catch { /* best effort */ }
}

/**
 * Apply a single value to a scanned field with the right control action.
 *
 * @param {object} page Playwright page (or fake)
 * @param {object} field scanned field descriptor (see domScanner.scanFields)
 * @param {string} value value to apply
 * @returns {Promise<{ok: boolean, action: string, error?: string}>}
 */
export async function applyValue(page, field, value, { requiresSponsorship } = {}) {
  const kind = field.kind ?? field.type ?? 'text';
  const resolvedValue = normalizeChoiceValue(field, value);
  // After ANY committed choice on a sponsorship/authorization question, read
  // the widget back and refuse — clearing what we can — when it contradicts
  // the candidate. See `sponsorshipChoiceConflict`.
  const confirmChoice = async (locator, action, fallbackChosen) => {
    const chosen = await readBackChoice(locator, kind, fallbackChosen);
    const conflict = sponsorshipChoiceConflict({
      label: field.label, intended: resolvedValue, chosen, requiresSponsorship,
    });
    if (conflict) {
      await clearChoice(kind, locator);
      return {
        ok: false, action, needsHuman: true, chosen,
        error: `refused to keep this answer: ${conflict} — answer it yourself`,
      };
    }
    return { ok: true, action, chosen };
  };
  try {
    if (kind === 'select') {
      const opt = matchOption(field.options, resolvedValue);
      if (!opt) return { ok: false, action: 'select', error: `no option matches "${resolvedValue}"` };
      if ((await safeCount(page, field.selector)) !== 1) return { ok: false, action: 'select', error: 'selector not unique' };
      const loc = page.locator(field.selector).first();
      // Prefer matching by value, fall back to label.
      try { await loc.selectOption(opt.value); }
      catch { await loc.selectOption({ label: opt.label }); }
      return confirmChoice(loc, 'select', opt.label ?? opt.value);
    }

    if (kind === 'checkbox') {
      if ((await safeCount(page, field.selector)) !== 1) return { ok: false, action: 'checkbox', error: 'selector not unique' };
      const on = AFFIRMATIVE.has(String(resolvedValue ?? '').trim().toLowerCase());
      const loc = page.locator(field.selector).first();
      if (on) { await (loc.check?.() ?? loc.click()); }
      else if (loc.uncheck) { await loc.uncheck(); }
      return { ok: true, action: on ? 'check' : 'uncheck' };
    }

    if (kind === 'radio') {
      const opt = matchOption(field.options, resolvedValue);
      if (!opt || !opt.selector) return { ok: false, action: 'radio', error: `no option matches "${resolvedValue}"` };
      if ((await safeCount(page, opt.selector)) !== 1) return { ok: false, action: 'radio', error: 'option not unique' };
      const loc = page.locator(opt.selector).first();
      await (loc.check?.() ?? loc.click());
      return confirmChoice(loc, 'radio', opt.label ?? opt.value);
    }

    if (kind === 'combobox') {
      if ((await safeCount(page, field.selector)) !== 1) return { ok: false, action: 'combobox', error: 'selector not unique' };
      const input = page.locator(field.selector).first();
      // Open the widget, type the value (react-select listens on input events),
      // then commit a matching option from the dropdown.
      try { await input.click?.(); } catch { /* best effort */ }
      await input.fill(String(resolvedValue));
      const res = await pickComboboxOption(page, field, resolvedValue);
      // Never leave stray filter text behind when we could not commit a choice —
      // an unselected combobox showing leftover text reads as a wrong answer.
      if (!res.ok) { try { await input.fill?.(''); } catch { /* best effort */ } return res; }
      return confirmChoice(input, res.action, res.chosen);
    }

    // text-like + textarea
    if ((await safeCount(page, field.selector)) !== 1) return { ok: false, action: 'fill', error: 'selector not unique' };
    await page.locator(field.selector).first().fill(String(resolvedValue));
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
  // File inputs are scanned (so required uploads are visible) but NEVER
  // planned or filled here — attaching documents is uploadRunner's job, and a
  // text value typed into a file input would be both wrong and rejected.
  const fillable = scannedFields.filter((f) => f.kind !== 'file');
  // Feed the existing deterministic planner (label -> value + source).
  const planInput = fillable.map((f) => ({
    label: f.label,
    selector: f.selector,
    choices: (f.options ?? []).map((o) => o.label ?? o.value).filter(Boolean),
  }));
  const { plan, needsUser } = buildPrefillPlan(planInput, { candidate, screeningAnswers });

  // Annotate each unanswerable field with whether the live form marks it
  // REQUIRED. The assistant stops only for required unknowns; optional ones
  // (e.g. middle name, address line 2, "decline to answer" EEO selects) are
  // simply left blank so the run can still advance.
  // `options` rides along so the dashboard's answer form can offer the choices
  // the live form actually had, instead of asking you to guess its wording.
  const needsUserAnnotated = needsUser.map((nu) => {
    const f = scannedFields.find(
      (s) => s.label === nu.label && (s.selector ?? null) === (nu.selector ?? null),
    );
    return { ...nu, required: f?.required === true, kind: f?.kind, options: f?.options ?? [] };
  });

  const requiresSponsorship = candidate?.workAuthorization?.requiresSponsorship
    ?? candidate?.sponsorshipRequired;
  const filled = [];
  const errors = [];
  for (const entry of plan) {
    const field = scannedFields.find((f) => f.label === entry.label && (f.selector ?? null) === (entry.selector ?? null));
    if (!field) continue;
    const key = field.selector ?? `${field.kind}:${field.name}`;
    if (alreadyFilled.has(key)) continue;
    const res = await applyValue(page, field, entry.value, { requiresSponsorship });
    if (res.ok) {
      alreadyFilled.add(key);
      filled.push({
        field: entry.field, label: entry.label, selector: field.selector, source: entry.source, action: res.action,
        kind: field.kind,
        // What the employer will actually read for a screening answer: the
        // committed option for a choice widget, else the typed text. Profile
        // values (name, email) are not repeated here.
        ...(entry.source === 'screening' ? { value: res.chosen ?? String(entry.value ?? '') } : {}),
      });
    } else if (res.error) {
      errors.push({ field: entry.field, label: entry.label, selector: field.selector, error: res.error });
      // A refused sponsorship/authorization choice is a question for the human,
      // and a REQUIRED one: the run must stop rather than advance past a blank
      // (or, for a radio group, a wrong) immigration answer.
      if (res.needsHuman) {
        needsUserAnnotated.push({
          label: entry.label, selector: field.selector ?? null, reason: res.error,
          required: true, kind: field.kind, options: field.options ?? [],
        });
      }
    }
  }
  return { filled, needsUser: needsUserAnnotated, errors };
}
