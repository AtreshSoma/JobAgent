/**
 * Placeholder (sentinel) detection for candidate configuration.
 *
 * Why this exists
 * ---------------
 * The shipped `.example` configs are TEMPLATES, and copying them is the exact
 * first step `doctor` and the README tell a new user to take. Every guard in the
 * system then passed them, because every guard tested for PRESENCE, not for
 * plausibility: `requiredProfileGaps` only rejects empty strings, and the JSON
 * schemas constrain types, not sentinel values.
 *
 * Verified at runtime against the untouched example files:
 *
 *   "Are you legally authorized to work in the United States?"
 *     -> "YOUR truthful authorization status."
 *   "Will you now or in the future require sponsorship?"
 *     -> "YOUR truthful sponsorship answer (e.g. 'No.' or 'Yes, ...')."
 *   assertTruthfulSponsorship(...) -> { truthful: true, violations: [] }
 *
 * and `doctor` reported "✓ Preflight passed — the pipeline is ready to run" for
 * a profile named Jane Doe, at you@example.com, in "Your City", whose work
 * authorization status read "US Citizen | Green Card | H-1B | OPT | ...".
 *
 * That is template text typed into a real employer's work-authorization field.
 * The guard below closes the whole class: it fails preflight hard and refuses
 * packet preparation whenever a value is still one of the shipped sentinels.
 *
 * Detection is deliberately conservative — a false positive only tells a user to
 * edit a field they can trivially make more specific, while a false negative
 * misrepresents them to an employer.
 */

/**
 * Patterns that mark a value as template text rather than a real answer.
 *
 * Each entry is matched against the trimmed value. These come from the strings
 * actually shipped in `config/candidate.example.json` and
 * `config/screening_answers.example.json`, plus the general shapes they follow.
 */
export const PLACEHOLDER_PATTERNS = [
  // The "YOUR ..." instruction form used throughout the example answers.
  /^your\b/i,
  /^your\s+total\b/i,
  /\byour truthful\b/i,
  // Example-domain contact details (RFC 2606 reserves example.com for exactly this).
  /@example\.(com|org|net)$/i,
  /^https?:\/\/(www\.)?example\.(com|org|net)/i,
  // "Your City" / "Your State" / "Your Company".
  /^your\s+(city|state|company|name|title|employer)$/i,
  // Placeholder personal names shipped in the example profile.
  /^(jane|john)\s+(doe|q\.?\s*public)$/i,
  /^(jane|john)$/i,
  // A menu of options left unchosen: "US Citizen | Green Card | H-1B | OPT | ..."
  // A real status is ONE of these, never the list.
  /\|\s*\.\.\.\s*$/,
  /^[^|]{2,40}(\s*\|\s*[^|]{2,40}){2,}$/,
  // Instructional text that describes what to write instead of writing it.
  /^describe\s+your\b/i,
  /^(one-line|one line),?\s+metric-backed/i,
  /\be\.g\.\s*'/i,
  // Example org names from the shipped profile and the synthetic resume.
  /^example\s+(corp|university|consulting|state university)$/i,
  // All-zero / obviously fake identifiers.
  /^0+$/,
  /^5551234567$/,
  /^\(?555\)?[-\s]?01\d\d/,
  // The literal placeholder LinkedIn handle.
  /linkedin\.com\/in\/your-handle/i,
];

/**
 * Candidate-profile fields that are typed onto a real employer's form and
 * therefore must never carry template text. `path` is dot-notation.
 */
export const GUARDED_PROFILE_FIELDS = [
  { path: 'identity.fullName', label: 'full name' },
  { path: 'identity.preferredName', label: 'preferred name' },
  { path: 'contact.email', label: 'email' },
  { path: 'contact.phone', label: 'phone' },
  { path: 'location.city', label: 'city' },
  { path: 'location.state', label: 'state' },
  { path: 'location.zip', label: 'ZIP code' },
  { path: 'identity.links.linkedin', label: 'LinkedIn URL' },
  { path: 'workAuthorization.status', label: 'work authorization status' },
  { path: 'workAuthorization.details', label: 'work authorization details' },
  // CAREER FACTS reach the employer too. The cover letter quotes
  // `workHistory[0].highlights[0]` verbatim ("In my current role I ...") and
  // the resume/profile pages name the employer and school, so an untouched
  // example profile produced a letter claiming "one-line, metric-backed
  // achievement bullet" at "Example Corp". `[*]` checks every entry.
  { path: 'workHistory[*].highlights', label: 'work-history highlight' },
  { path: 'workHistory[*].employer', label: 'work-history employer' },
  { path: 'education[*].institution', label: 'education institution' },
];

/**
 * Is this value still shipped template text?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlaceholderValue(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(text));
}

/**
 * Every value at a dot-notation path, with concrete paths.
 *
 * `name[*]` expands every element of an array, and a leaf that is itself an
 * array (a list of highlights) yields each element, so one guard entry covers
 * every job in a work history rather than only the first.
 *
 * @param {object} obj
 * @param {string} path e.g. 'identity.fullName' or 'workHistory[*].highlights'
 * @returns {Array<{path: string, value: unknown}>}
 */
export function valuesAtPath(obj, path) {
  let frontier = [{ path: '', value: obj }];
  for (const segment of path.split('.')) {
    const wildcard = segment.endsWith('[*]');
    const key = wildcard ? segment.slice(0, -3) : segment;
    const next = [];
    for (const { path: at, value } of frontier) {
      if (value == null) continue;
      const child = value[key];
      const here = at ? `${at}.${key}` : key;
      if (wildcard) {
        if (Array.isArray(child)) child.forEach((item, i) => next.push({ path: `${here}[${i}]`, value: item }));
      } else {
        next.push({ path: here, value: child });
      }
    }
    frontier = next;
  }
  return frontier.flatMap(({ path: at, value }) => (Array.isArray(value)
    ? value.map((item, i) => ({ path: `${at}[${i}]`, value: item }))
    : [{ path: at, value }]));
}

/**
 * Every guarded candidate field still holding template text.
 *
 * @param {object} candidate parsed config/candidate.json
 * @returns {Array<{path: string, label: string, value: string}>}
 */
export function candidatePlaceholders(candidate = {}) {
  const found = [];
  for (const field of GUARDED_PROFILE_FIELDS) {
    for (const { path, value } of valuesAtPath(candidate ?? {}, field.path)) {
      if (isPlaceholderValue(value)) {
        found.push({ ...field, path, value: String(value).trim() });
      }
    }
  }
  return found;
}

/** A `{token}` left behind by a template that was not filled. */
export const TEMPLATE_TOKEN_RE = /\{\w+\}/;

/**
 * Every unfilled `{token}` in a piece of text (deduplicated, in order).
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function findTemplateTokens(text) {
  return [...new Set(String(text ?? '').match(new RegExp(TEMPLATE_TOKEN_RE.source, 'g')) ?? [])];
}

/**
 * Refuse an employer-facing document that still contains template tokens.
 *
 * Everything else in this module detects shipped EXAMPLE values; this detects
 * a template the generator failed to fill. Both end the same way: a real
 * employer reading "{title}" or "{company}" in a letter signed with the
 * candidate's name. Throws with the offending tokens named so the user knows
 * which template sentence to fix.
 *
 * @param {unknown} text the document text
 * @param {string} [what='document'] what the text is, for the message
 * @throws {Error} when any `{token}` remains
 */
export function assertNoTemplateTokens(text, what = 'document') {
  const tokens = findTemplateTokens(text);
  if (tokens.length) {
    throw new Error(
      `Refusing to produce this ${what}: it still contains unfilled template placeholder(s) `
      + `${tokens.join(', ')}. Fix the template in config/cover_letter.json or the profile value `
      + 'it draws on; a document addressed to an employer must never ship template text.',
    );
  }
}

/**
 * Every screening answer still holding template text.
 *
 * These are the most dangerous of all: they are written verbatim into an
 * employer's form, and the work-authorization and sponsorship entries are
 * legally material.
 *
 * @param {object} screeningAnswers parsed config/screening_answers.json
 * @returns {Array<{path: string, label: string, value: string}>}
 */
export function screeningAnswerPlaceholders(screeningAnswers = {}) {
  const found = [];
  const answers = Array.isArray(screeningAnswers.answers) ? screeningAnswers.answers : [];
  for (const entry of answers) {
    if (isPlaceholderValue(entry?.answer)) {
      found.push({
        path: `answers[id=${entry.id}].answer`,
        label: `screening answer "${entry.id}"`,
        value: String(entry.answer).trim(),
      });
    }
  }
  return found;
}

/**
 * Cover-letter values still holding template text.
 *
 * `config/cover_letter.json` used to be TRACKED, so every clone shipped one
 * person's "10+ years" and their H-1B sentence — and both go verbatim into a
 * letter addressed to an employer. It is now gitignored with an example like
 * the other personal configs, which means it needs the same sentinel guard.
 *
 * @param {object} coverLetter parsed config/cover_letter.json
 * @returns {Array<{path: string, label: string, value: string}>}
 */
export function coverLetterPlaceholders(coverLetter = {}) {
  const found = [];
  if (isPlaceholderValue(coverLetter.yearsOfExperience)) {
    found.push({
      path: 'yearsOfExperience',
      label: 'years of experience (used in the cover letter)',
      value: String(coverLetter.yearsOfExperience).trim(),
    });
  }
  // Only material when the note is actually emitted.
  const note = coverLetter?.template?.sponsorshipNote;
  if (coverLetter.includeSponsorshipNote !== false && isPlaceholderValue(note)) {
    found.push({
      path: 'template.sponsorshipNote',
      label: 'cover-letter sponsorship sentence',
      value: String(note).trim(),
    });
  }
  return found;
}

/**
 * Every placeholder across the whole configuration bundle.
 *
 * @param {{candidate?: object, screeningAnswers?: object}} config loadConfig() bundle
 * @returns {{
 *   ok: boolean,
 *   placeholders: Array<{path: string, label: string, value: string, file: string}>,
 *   problems: string[]
 * }}
 */
export function findPlaceholders(config = {}) {
  const placeholders = [
    ...candidatePlaceholders(config.candidate).map((p) => ({ ...p, file: 'config/candidate.json' })),
    ...screeningAnswerPlaceholders(config.screeningAnswers)
      .map((p) => ({ ...p, file: 'config/screening_answers.json' })),
    ...coverLetterPlaceholders(config.coverLetter)
      .map((p) => ({ ...p, file: 'config/cover_letter.json' })),
  ];

  const problems = placeholders.map(
    (p) => `${p.file}: ${p.label} is still template text ("${truncate(p.value)}") — replace it with your real, truthful value.`,
  );

  return { ok: placeholders.length === 0, placeholders, problems };
}

function truncate(text, max = 72) {
  const t = String(text);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
