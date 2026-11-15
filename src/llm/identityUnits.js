/**
 * Keep the person's name and contact details out of model requests (audit N1).
 *
 * Resume units (tailor.py master_units) are what the optional model features
 * cite as evidence. The top of a resume is the name line and a contact line,
 * and both come back as ordinary `paragraph` units, so a feature that sent
 * "every paragraph" sent "Jordan Example" and "Springfield, IL | 555-010-0000 |
 * jordan@example.com" to the provider. Only those lines are dropped here; the
 * summary, headline and every bullet still go, because they are the evidence.
 *
 * A unit is dropped when it is:
 *   - above the first section heading (the identity block) and is the name
 *     line, a contact line (email, phone, web link) or a bare location line;
 *   - anywhere, a line carrying an email address or a phone number, the
 *     person's full name on its own, or one of the person's own profile links.
 *
 * Pure: no I/O, so every payload builder can call it and tests can pin it.
 */

const EMAIL_RE = /[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[a-z]{2,}/i;
// A phone-shaped run: digits with spaces, dots, dashes or brackets between.
const PHONE_RUN_RE = /\+?\(?\d[\d\s().-]{6,}\d/g;
const WEB_RE = /\bhttps?:\/\/\S+|\bwww\.\S+|\b(?:linkedin|github)\.com\/\S*/i;
// "Springfield, IL" or "Springfield, IL 62701": a city and a two-letter
// region, optionally a ZIP, and nothing else on the line.
const LOCATION_LINE_RE = /^[A-Z][A-Za-z .'-]{1,40},\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/;

const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const linkKey = (value) => squash(value).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');

function hasPhone(text) {
  for (const match of String(text ?? '').matchAll(PHONE_RUN_RE)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return true;
  }
  return false;
}

function profileOf(candidate = {}) {
  const links = Object.values(candidate?.identity?.links ?? {})
    .map(linkKey).filter((key) => key.length > 4);
  return {
    name: squash(candidate?.identity?.fullName),
    email: squash(candidate?.contact?.email),
    links,
  };
}

/** True for a line that carries contact details wherever it sits. */
function carriesContact(text, profile) {
  const line = squash(text);
  if (!line) return false;
  if (EMAIL_RE.test(line) || hasPhone(line)) return true;
  if (profile.email && line.includes(profile.email)) return true;
  if (profile.name && line === profile.name) return true;
  const linkText = linkKey(text);
  return profile.links.some((key) => linkText.includes(key));
}

/** True for a contact-shaped line in the identity block. */
function identityLine(text) {
  const raw = String(text ?? '').trim();
  return WEB_RE.test(raw) || LOCATION_LINE_RE.test(raw);
}

/**
 * Drop only lines that carry contact details (email, phone, the person's
 * name on its own or their profile links). For text that has no identity
 * block of its own, such as the paragraphs of a master cover letter or a
 * list of bullets.
 *
 * @template {{ text?: string }} U
 * @param {U[]} units
 * @param {object} [candidate]
 * @returns {U[]}
 */
export function withoutContactLines(units, candidate = {}) {
  const profile = profileOf(candidate);
  return (Array.isArray(units) ? units : []).filter((unit) => !carriesContact(unit?.text ?? '', profile));
}

/**
 * @template {{ kind?: string, text?: string }} U
 * @param {U[]} units resume units, in document order
 * @param {object} [candidate] the profile, when known (sharpens name/link matching)
 * @returns {U[]} the same units, minus name and contact lines
 */
export function withoutIdentityUnits(units, candidate = {}) {
  const list = Array.isArray(units) ? units : [];
  const profile = profileOf(candidate);
  const hasSections = list.some((u) => u?.kind === 'section');
  const blockEnd = list.findIndex((u) => (hasSections
    ? u?.kind === 'section'
    : u?.kind === 'role' || u?.kind === 'bullet'));
  const firstText = list.findIndex((u) => String(u?.text ?? '').trim());

  return list.filter((unit, index) => {
    const text = unit?.text ?? '';
    if (carriesContact(text, profile)) return false;
    const inIdentityBlock = blockEnd === -1 || index < blockEnd;
    if (!inIdentityBlock) return true;
    // The first line of a resume is the name. With a known name, only a line
    // that is the name counts, so a resume whose name sits in the page header
    // keeps its first body line (often a headline).
    if (index === firstText && (!profile.name || squash(text) === profile.name)) return false;
    return !identityLine(text);
  });
}
