/**
 * Field resolver / filler.
 *
 * Consumes a packet's fill plan and, against a live Playwright page, (a) checks
 * which planned selectors actually resolve to a single element and (b) fills the
 * resolved text fields. It only fills values that came from the candidate
 * profile or config-backed screening answers — it never invents input. Select /
 * radio / unknown widgets are reported as "needs human" rather than guessed.
 *
 * The page is accessed through a tiny interface (`locator(sel).count()/.fill()`)
 * so a fake page can drive unit tests, while the real Playwright page is used in
 * fixture integration tests.
 */

/**
 * Count how many elements a selector matches (0 if it errors).
 * @param {object} page
 * @param {string} selector
 * @returns {Promise<number>}
 */
async function safeCount(page, selector) {
  if (!selector) return 0;
  try {
    return await page.locator(selector).count();
  } catch {
    return 0;
  }
}

/**
 * Resolve each fill-plan step against the page without typing anything.
 *
 * @param {object} page Playwright page (or compatible)
 * @param {object} fillPlan packet.fillPlan ({ steps: [...] })
 * @returns {Promise<{ resolved: object[], unresolved: object[] }>}
 */
export async function resolveFields(page, fillPlan = {}) {
  const steps = Array.isArray(fillPlan.steps) ? fillPlan.steps : [];
  const resolved = [];
  const unresolved = [];
  for (const step of steps) {
    const count = await safeCount(page, step.selector);
    if (count === 1 && step.value != null && step.value !== '') {
      resolved.push({ ...step, matchCount: count });
    } else {
      unresolved.push({ ...step, matchCount: count, reason: reasonFor(step, count) });
    }
  }
  return { resolved, unresolved };
}

function reasonFor(step, count) {
  if (!step.selector) return 'no selector';
  if (count === 0) return 'selector not found on page';
  if (count > 1) return `selector matched ${count} elements (ambiguous)`;
  if (step.value == null || step.value === '') return 'no value to fill';
  return 'unresolved';
}

/**
 * Fill the resolved text fields.
 *
 * @param {object} page
 * @param {object} fillPlan
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] resolve only; do not type
 * @returns {Promise<{ filled: object[], unresolved: object[], errors: object[] }>}
 */
export async function fillFields(page, fillPlan = {}, { dryRun = false } = {}) {
  const { resolved, unresolved } = await resolveFields(page, fillPlan);
  const filled = [];
  const errors = [];

  if (dryRun) {
    return { filled, unresolved, errors, plannedFills: resolved };
  }

  for (const step of resolved) {
    try {
      await page.locator(step.selector).first().fill(String(step.value));
      filled.push({ field: step.field, label: step.label, selector: step.selector, source: step.source });
    } catch (err) {
      errors.push({ field: step.field, selector: step.selector, error: err.message });
    }
  }
  return { filled, unresolved, errors };
}

/**
 * Are all required fields filled? Required = profile-sourced identity/contact
 * fields present in the plan. A missing required field blocks submission.
 *
 * @param {object[]} filled result of fillFields().filled
 * @param {object} fillPlan
 * @param {string[]} [required=['email']] canonical required field names
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function requiredFieldsSatisfied(filled = [], fillPlan = {}, required = ['email']) {
  const steps = Array.isArray(fillPlan.steps) ? fillPlan.steps : [];
  const filledSet = new Set(filled.map((f) => f.field));
  const planned = new Set(steps.map((s) => s.field));
  const missing = [];
  for (const field of required) {
    // Only enforce fields the form actually asks for.
    if (planned.has(field) && !filledSet.has(field)) missing.push(field);
  }
  return { ok: missing.length === 0, missing };
}
