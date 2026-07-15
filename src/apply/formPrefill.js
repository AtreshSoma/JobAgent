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

/** Name-ish canonical fields handled by the dedicated, combined-aware resolver. */
const NAME_FIELDS = new Set(['firstName', 'lastName', 'preferredName', 'fullName']);

/**
 * Profile fields are SHORT, label-like text. A long sentence or question (a
 * legal acknowledgement paragraph, or "Do you now or will you in the future
 * need an employer to sponsor you…?") is NEVER a profile text field — treating
 * one as such is exactly how a stray word like "stated" or "United States" used
 * to get the candidate's State written into the wrong control. Anything longer
 * than this many words is left to the screening matcher instead.
 */
const MAX_LABEL_WORDS = 8;

/** Whole-word test, so "state" matches "state" but never "stated"/"states". */
function hasWord(text, word) {
  const w = String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${w}\\b`).test(text);
}

/** True when the words of `phrase` appear as a contiguous run inside `tokens`. */
function containsPhrase(tokens, phrase) {
  const p = phrase.split(' ').filter(Boolean);
  if (!p.length) return false;
  for (let i = 0; i + p.length <= tokens.length; i += 1) {
    let ok = true;
    for (let j = 0; j < p.length; j += 1) {
      if (tokens[i + j] !== p[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Resolve a name field, aware that one control often asks for several name
 * parts at once: "Legal First and Last Name" / "First & Last Name" wants the
 * FULL name, not just the last name (which naive substring matching produced).
 * Only fires when the word "name" (or "surname") actually appears, so a
 * question like "When did you first…?" is never mistaken for a name field.
 *
 * @param {string} text normalized, punctuation-free label
 * @returns {('firstName'|'lastName'|'preferredName'|'fullName'|null)}
 */
function classifyNameField(text) {
  const surname = hasWord(text, 'surname');
  if (!hasWord(text, 'name') && !surname) return null;

  const preferred = hasWord(text, 'preferred') || hasWord(text, 'nickname') || /\bgoes by\b/.test(text);
  const first = hasWord(text, 'first') || hasWord(text, 'given');
  const last = hasWord(text, 'last') || surname || hasWord(text, 'family');

  if (first && last) return 'fullName';      // "First and Last Name"
  if (preferred) return 'preferredName';
  if (first) return 'firstName';
  if (last) return 'lastName';
  if (hasWord(text, 'full') || hasWord(text, 'legal') || hasWord(text, 'complete')) return 'fullName';
  return 'fullName';                          // bare "Name" / "Your Name"
}

/** Identify the canonical field for a form label, or null. */
export function classifyLabel(label) {
  const text = normalizeText(label);
  if (!text) return null;
  // Punctuation-free tokens, so "states?" -> ["states"] and "stated" -> ["stated"]
  // can never be confused with the whole word "state".
  const tokens = text.match(/[a-z0-9]+/g) || [];
  if (!tokens.length) return null;
  const clean = tokens.join(' ');

  // 1. Exact label match — highest precision, always allowed.
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.includes(text) || aliases.includes(clean)) return field;
  }

  // 2. Long sentences/questions are screening questions, not profile fields.
  if (tokens.length > MAX_LABEL_WORDS) return null;

  // 3. Name fields (combined-aware: "First and Last Name" => full name).
  const nameField = classifyNameField(clean);
  if (nameField) return nameField;

  // 4. Whole-word / phrase matching for the remaining canonical fields.
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (NAME_FIELDS.has(field)) continue;
    const blockers = FIELD_DISQUALIFIERS[field];
    if (blockers && blockers.some((b) => hasWord(clean, b))) continue;
    if (aliases.some((a) => containsPhrase(tokens, a))) return field;
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
    } else if (qa.action !== 'skip') {
      // 'skip' (config defaults.unknownAction) leaves the field blank without
      // blocking; the live form's own required check still stops the run.
      needsUser.push({ label: field.label, selector: field.selector ?? null, reason: 'no high-confidence answer' });
    }
  }

  return { plan, needsUser, submitReady: false };
}
