/**
 * Form prefill planner.
 *
 * Builds a deterministic mapping of standard application form fields to values
 * drawn from the candidate profile + screening answers. It produces a PLAN only
 * (label -> value + source); it never submits anything. No browser automation
 * exists yet; a future assisted form-filler would consume this plan and would
 * still stop before final submit.
 */

import { classifyLabel } from '../shared/fieldLabels.js';
import { answerScreeningQuestion } from './screeningQA.js';

// The label classifier is shared with the browser extension (audit A12).
export { classifyLabel };

/**
 * Resolve a value for a known canonical field from the candidate profile.
 * @param {string} field
 * @param {object} candidate
 * @returns {string|null}
 */
export function valueForField(field, candidate = {}) {
  const id = candidate.identity ?? {};
  const contact = candidate.contact ?? {};
  const loc = candidate.location ?? {};
  const links = id.links ?? {};
  const full = id.fullName ?? '';
  const [first, ...rest] = full.split(' ');
  switch (field) {
    case 'firstName': return first || null;
    case 'lastName': return rest.length ? rest.join(' ') : null;
    case 'preferredName': return id.preferredName || first || null;
    case 'fullName': return full || null;
    case 'email': return contact.email || null;
    case 'phone': return contact.phone || null;
    case 'addressLine1': return loc.street || null;
    case 'addressLine2': return loc.street2 || null;
    case 'city': return loc.city || null;
    case 'state': return loc.state || null;
    case 'zip': return loc.zip || null;
    case 'country': return loc.country || null;
    // For a single "Location" typeahead, seed with the city; the widget's
    // option list resolves the full "City, State, Country" string on select.
    case 'location': return loc.city || null;
    case 'linkedin': return links.linkedin || null;
    case 'github': return links.github || null;
    case 'portfolio': return links.portfolio || null;
    // The employer of the role the profile marks CURRENT. No current role
    // stated, no answer: the most recent past employer is not "current".
    case 'currentCompany': {
      const history = Array.isArray(candidate.workHistory) ? candidate.workHistory : [];
      const current = history.filter((w) => w?.current === true && String(w?.employer ?? '').trim());
      return current.length === 1 ? String(current[0].employer).trim() : null;
    }
    default: return null;
  }
}

/**
 * Build a fill plan for a set of form fields.
 *
 * @param {Array<{label: string, selector?: string, choices?: string[]}>} fields
 * @param {object} args
 * @param {object} args.candidate
 * @param {object} args.screeningAnswers
 * @returns {{
 *   plan: Array<object>,
 *   needsUser: Array<object>,
 *   submitReady: false
 * }}
 */
export function buildPrefillPlan(fields = [], { candidate, screeningAnswers } = {}) {
  const plan = [];
  const needsUser = [];

  for (const field of fields) {
    const canonical = classifyLabel(field.label);
    if (canonical) {
      const value = valueForField(canonical, candidate);
      if (value !== null && value !== '') {
        plan.push({ label: field.label, selector: field.selector ?? null, field: canonical, value, source: 'profile' });
        continue;
      }
    }

    // Otherwise treat it as a screening question.
    // `candidate` supplies skillExperience, the only honest source for a
    // qualified duration question ("years of experience with X").
    const qa = answerScreeningQuestion(field.label, screeningAnswers, { choices: field.choices, candidate });
    if (qa.answered) {
      plan.push({ label: field.label, selector: field.selector ?? null, field: qa.matchedId, value: qa.answer, source: 'screening' });
    } else if (qa.action !== 'skip') {
      // 'skip' (config defaults.unknownAction) leaves the field blank without
      // blocking; the live form's own required check still stops the run.
      needsUser.push({ label: field.label, selector: field.selector ?? null, reason: 'no high-confidence answer' });
    }
  }

  return { plan, needsUser, submitReady: false };
}
