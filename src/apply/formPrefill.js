/**
 * Form prefill planner.
 *
 * Builds a deterministic mapping of standard application form fields to values
 * drawn from the candidate profile + screening answers. It produces a PLAN only
 * (label -> value + source); it never submits anything. No browser automation
 * exists yet; a future assisted form-filler would consume this plan and would
 * still stop before final submit.
 */

import { normalizeText } from '../utils/textNormalize.js';
import { answerScreeningQuestion } from './screeningQA.js';

/** Canonical field -> phrases that identify it on a form. */
const FIELD_ALIASES = {
  firstName: ['first name', 'given name'],
  lastName: ['last name', 'surname', 'family name'],
  preferredName: ['preferred name', 'preferred first name', 'nickname', 'goes by'],
  fullName: ['full name', 'name'],
  email: ['email', 'e-mail'],
  phone: ['phone', 'mobile', 'telephone'],
  addressLine1: ['address line 1', 'address line1', 'street address', 'address'],
  addressLine2: ['address line 2', 'address line2', 'apt', 'suite', 'unit'],
  city: ['city'],
  state: ['state', 'province', 'region'],
  zip: ['zip', 'zip code', 'postal code', 'postcode', 'postal'],
  country: ['country'],
  location: ['location', 'where are you located', 'current location'],
  linkedin: ['linkedin'],
  github: ['github'],
  portfolio: ['portfolio', 'website', 'personal site'],
};

/**
 * Phrases that DISQUALIFY an otherwise-matching substring, so greedy matching
 * never writes a value into the wrong control. Without this, labels like
 * "Phone Extension", "Phone Device Type", and "Country Phone Code" would all be
 * treated as the phone-number field (they each contain "phone") and get filled
 * with the candidate's phone number. Checked during substring matching only.
 */
const FIELD_DISQUALIFIERS = {
  phone: ['extension', 'device', 'type', 'code'],
};

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
    default: return null;
  }
}

/** Identify the canonical field for a form label, or null. */
export function classifyLabel(label) {
  const text = normalizeText(label);
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.some((a) => text === a)) return field;
  }
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const blockers = FIELD_DISQUALIFIERS[field];
    if (blockers && blockers.some((b) => text.includes(b))) continue;
    if (aliases.some((a) => text.includes(a))) return field;
  }
  return null;
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
    const qa = answerScreeningQuestion(field.label, screeningAnswers, { choices: field.choices });
    if (qa.answered) {
      plan.push({ label: field.label, selector: field.selector ?? null, field: qa.matchedId, value: qa.answer, source: 'screening' });
    } else {
      needsUser.push({ label: field.label, selector: field.selector ?? null, reason: 'no high-confidence answer' });
    }
  }

  return { plan, needsUser, submitReady: false };
}
