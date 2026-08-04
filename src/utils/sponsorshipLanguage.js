/**
 * Sponsorship POLARITY reader — does this JD offer sponsorship, or refuse it?
 *
 * REGRESSION GUARD. Sponsorship used to be decided by plain phrase presence
 * (`matchedPhrases(jd, affirmativePhrases)`), which is polarity-blind: the
 * configured affirmative phrase "work visa sponsorship" matched inside the
 * sentence
 *
 *     "This role is not eligible for work visa sponsorship."
 *
 * so the single strongest DENIAL a posting can carry was read as a
 * CONFIRMATION. Measured against the 38,823 stored JDs before this fix: 85
 * jobs survived the exclusion filter and were labelled "Confirmed" off a
 * negated phrase, including 6 of 6 Humana rows — every one an explicit
 * refusal. Each cost a green "Confirmed" badge, +15 weighted score points
 * (sponsorshipFeasibility + companySponsorshipLikelihood), and a pass through
 * the sponsorship gate into auto-preparation.
 *
 * Adding more phrases to config could never fix this: a denial is not a phrase,
 * it is a phrase plus a negation, and the negation lives in prose the phrase
 * list cannot see. So both directions are read HERE, from one primitive, and
 * both the classifier (scoring/sponsorshipClassifier.js) and the hard exclusion
 * filter (scoring/exclusionFilter.js) call into it — they can no longer
 * disagree about whether a posting sponsors.
 *
 * The two directions are deliberately asymmetric in strictness, because their
 * failure modes cost different amounts:
 *
 *   - SUPPRESSING A CONFIRMATION is fail-safe. Getting it wrong parks a job in
 *     Queue for a human sponsorship check. So negation detection here is
 *     LIBERAL: any negation cue in the preceding clause is enough.
 *
 *   - DECLARING A DENIAL hard-discards the job. Getting it wrong silently
 *     deletes a good posting — the exact failure that made `roleMismatch`
 *     throw away 2,502 senior roles for saying "mentor junior engineers". So
 *     denial detection is STRICT: the negation must form a recognized denial
 *     construction ADJACENT to the sponsorship term, not merely appear
 *     somewhere nearby.
 */

/**
 * Normalization that KEEPS line breaks, because they are clause boundaries.
 *
 * `normalizeText` collapses every whitespace run — newlines included — to single
 * spaces. Most JDs are bullet lists with no terminating periods, so under that
 * normalization an entire posting is one unbounded "clause" and a negation from
 * an unrelated bullet could reach the sponsorship line hundreds of characters
 * away. Preserving `\n` restores the boundary that the layout actually encodes.
 *
 * All three strings this module derives (`kept`, `flat`, `masked`) are the SAME
 * LENGTH, so one index is valid against all of them.
 */
function normalizeKeepLines(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .toLowerCase()
    // Carriage returns and the Unicode line/paragraph separators are real line
    // breaks. Folded 1:1 so length — and therefore every index — is preserved.
    .replace(/[\r\u2028\u2029]/g, '\n')
    // Every whitespace character EXCEPT newline collapses to a single space.
    .replace(/[^\S\n]+/g, ' ');
}

/** Same-length copy with newlines flattened, for phrase matching. */
function flatten(kept) {
  return kept.replace(/\n/g, ' ');
}

/**
 * Sponsorship as a TOPIC. Every occurrence is examined in context rather than
 * trusted or rejected on sight. Modifiers ("work visa", "immigration", "h-1b")
 * are intentionally NOT part of this pattern — they are absorbed by the
 * bounded filler in the denial constructions below, so one topic hit covers
 * "sponsorship", "visa sponsorship", "work visa sponsorship" alike.
 */
const SPONSOR_TOPIC_RE = /\b(?:sponsorship|sponsors|sponsoring|sponsored|sponsor)\b/g;

/**
 * Clause boundaries. A negation cannot reach across one of these, which is what
 * keeps "No prior experience needed; visa sponsorship available" an
 * AFFIRMATIVE. Commas are deliberately NOT boundaries: real denials run through
 * them ("For this role, we are unable to sponsor"), and over-negating only
 * costs a Queue placement.
 */
const CLAUSE_BOUNDARY = /[.;!?\n\r•·]/;

/**
 * Abbreviation periods are NOT sentence boundaries.
 *
 * REGRESSION GUARD. Treating every "." as a clause end truncated the window at
 * the abbreviation in real refusals, so the negation fell outside it:
 *
 *   "This role is not eligible for U.S. immigration SPONSORSHIP."   (Google)
 *   "U.S. work visa SPONSORSHIP (such as TN, O-1, etc.) is not
 *    available for this role now or in the future."                 (Pfizer)
 *
 * Both were labelled "Confirmed" — the window ended at "u.s." / "etc.",
 * hiding "not eligible for" and "is not available" respectively.
 *
 * The mask replaces only such periods with a SPACE, preserving string length so
 * every index stays valid against the unmasked text.
 */
const ABBREVIATIONS = [
  'etc', 'inc', 'ltd', 'llc', 'co', 'corp', 'vs', 'approx', 'est', 'dept',
  'no', 'min', 'max', 'yrs', 'mos', 'sr', 'jr', 'mr', 'ms', 'mrs', 'dr', 'st',
  'ave', 'blvd', 'ext', 'ref', 'req', 'fig', 'al',
];
const ABBREV_RE = new RegExp(`\\b(?:${ABBREVIATIONS.join('|')})\\.`, 'g');

/** Same-length copy of `t` with abbreviation/decimal periods neutralized. */
function maskAbbreviations(t) {
  return t
    // "u.s." / "e.g." / "i.e." — a period following a single letter.
    .replace(/(?<=\b[a-z])\./g, ' ')
    // Decimals and version numbers: "3.5", "1.0".
    .replace(/(?<=\d)\.(?=\d)/g, ' ')
    .replace(ABBREV_RE, (m) => `${m.slice(0, -1)} `);
}

/**
 * How far back a STRICT denial construction may start. Short on purpose: the
 * construction has to be adjacent to the term to earn a hard discard.
 */
const LOOKBEHIND = 90;

/**
 * How far back a LIBERAL negation cue may sit when merely suppressing an
 * affirmative. Effectively the whole sentence, because real refusals put the
 * negation far from the noun:
 *
 *   "…the company may not be able to employ candidates for this role who have
 *    US work authorization related to certain visa categories, or support
 *    future H-1B SPONSORSHIP at this time."
 *
 * The negation sits ~150 characters before the term, across a coordination.
 * Reading only 90 characters back labelled that Roblox posting "Confirmed".
 * Suppression is fail-safe (the job lands in Queue for a human check), so it
 * gets the generous window while denial keeps the strict one.
 */
const SUPPRESS_LOOKBEHIND = 420;

/** How far forward a trailing denial ("sponsorship is not available") may sit. */
const LOOKAHEAD = 90;

/**
 * Negation cues that suppress an affirmative phrase — liberal by design, since
 * over-suppressing only parks a job in Queue for a human check.
 *
 * Checked against the preceding clause. "not only" is stripped from the window
 * before the test, because "Not only do we sponsor visas, we also…" is an
 * affirmative and reading it as a negation would suppress a real confirmation.
 */
const SUPPRESSING_CUES = [
  /\bnot\b/, /\bno\b/, /\bnon-?\b/, /\bnever\b/, /\bcannot\b/, /\bcan['’]?t\b/,
  /\bunable\b/, /\bwithout\b/, /\bineligible\b/, /\bunwilling\b/, /\bnor\b/,
  /\bexcludes?\b/, /\bexcept\b/, /\bunavailable\b/, /\bdoes\s+n['’]?t\b/,
  /\bdon['’]?t\b/, /\bwon['’]?t\b/, /\bwe\s+are\s+not\b/, /\bunfortunately\b/,
];

/**
 * The negating HEAD of a denial. "does not require" is deliberately absent:
 * "does not require sponsorship" is ambiguous prose and this gates a hard
 * discard, so only `must not require` (an unambiguous candidate requirement) is
 * accepted, further down.
 */
const NEG_HEAD = '(?:'
  + 'not\\s+eligible\\s+(?:for|to\\s+receive)|in-?eligible\\s+for|not\\s+qualified\\s+for'
  + '|(?:does|do|did|will|would|can|could|shall|are|is|am|was|were|has|have)\\s+not'
  + '|cannot|can[\'’]?t|won[\'’]?t|doesn[\'’]?t|don[\'’]?t|didn[\'’]?t|isn[\'’]?t|aren[\'’]?t'
  + '|unable|not\\s+in\\s+a\\s+position'
  + '|no|without|must\\s+not\\s+require|not'
  + ')';

/**
 * Connector words a denial head may cross to reach the sponsorship term —
 * enumerated rather than a wildcard filler.
 *
 * This bounded walk is the precision device that replaced an
 * "up-to-32-arbitrary-characters" filler. The wildcard version also matched
 * across unrelated prose, e.g. it read
 *
 *     "…do NOT apply for this role if you will need GM immigration SPONSORSHIP"
 *
 * as a refusal-adjacent construction. Only these specific auxiliary/modal words
 * may sit between the negation and the term, so an arbitrary subordinate clause
 * can no longer bridge the two.
 */
const CONNECT = '(?:\\s*(?:be|being|been|currently|presently|generally|typically|normally'
  + '|now|at\\s+this\\s+time|at\\s+present|able|willing|eligible|in\\s+a\\s+position|to'
  + '|offer|offers|offering|provide|provides|providing|sponsor|sponsors|sponsoring'
  + '|support|supports|supporting|extend|extends|grant|grants|consider|considers'
  + '|entertain|accept|accepts|apply|applies|seeking|seek|require|requiring|need'
  + '|the|a|an|any|for|of|receive|obtain|this|that|role|position|candidates?'
  + '))*';

/**
 * Noun modifiers that may sit directly in front of the sponsorship term —
 * "work visa sponsorship", "new h1b sponsorship", "visa transfer / sponsorship",
 * "immigration-related sponsorship".
 *
 * `-` joins the separator class so hyphenated compounds ("immigration-related")
 * decompose into listed tokens instead of blocking the walk.
 */
const MODS = '(?:\\s*(?:work|employment|employer|visa|visas|immigration|h-?1-?b|h1b'
  + '|green\\s*card|permanent\\s+residency|new|additional|further|us|u\\.s\\.'
  + '|international|student|opt|cpt|tn|e-?3|corporate|company|any|the|of|for'
  + '|related|based|transfer|transfers|petition|petitions|status|type|types'
  // A lone letter is the residue of a masked abbreviation ("u.s." -> "u s"), so
  // MODS must be able to cross it — otherwise "not eligible for U.S. immigration
  // sponsorship" (Google) is recognized as negated but not as a strict denial.
  + '|[a-z](?![a-z])'
  + ')|\\s*[/,&-]\\s*)*\\s*';

/**
 * STRICT denial constructions that must sit immediately BEFORE the sponsorship
 * term (anchored to the end of the preceding clause, hence the `$`). The
 * anchoring is what requires the denial to govern THIS term rather than merely
 * appear in the same sentence.
 */
const DENIAL_BEFORE_RES = [
  new RegExp(`\\b${NEG_HEAD}${CONNECT}${MODS}$`),
];

/**
 * Material a trailing denial may reach across: an example parenthetical and/or
 * a short scope phrase.
 *
 * The trailing family is kept deliberately narrow — only "X is not available" —
 * so "we will sponsor candidates who do not require relocation" is never
 * mistaken for a refusal. Real postings do interpose both kinds of material:
 *
 *   "U.S. work visa SPONSORSHIP (such as TN, O-1, H-1B, etc.) is not available
 *    for this role now or in the future."
 *
 * Anchoring `^(?:is|are)` immediately after the term read that Pfizer posting as
 * "Confirmed" — the refusal sat behind the parenthetical.
 */
const AFTER_BRIDGE = '(?:\\s*(?:\\([^)]{0,70}\\)|for|this|the|of|to|a|an|any|role|roles'
  + '|position|positions|req|requisition|opportunity|candidates?|applicants?|employment'
  + '|at|in|on|us|and|or|support|assistance|sponsorship|transfer|transfers|visa|visas'
  + '|benefits?|services?))*\\s*';

const DENIAL_AFTER_RES = [
  // "sponsorship is not available" / "…will not be provided" / "…is unavailable"
  // The modal is matched BARE so "will not be provided" works: an alternation of
  // "will be" could never match, because "not" sits between the two words.
  new RegExp(`^${AFTER_BRIDGE}(?:(?:is|are|was|were|will|would|can|could|shall|may|might|do|does|has|have)\\s+)?(?:be\\s+)?(?:not\\s+(?:be\\s+|been\\s+)?(?:available|offered|provided|possible|considered|an\\s+option|supported|sponsored|granted|extended)|unavailable|un-?available)\\b`),
  // "sponsorship: no / none / not available / n/a"
  /^\s*[:\-–—]\s*(?:no\b|none\b|not\s+available|not\s+offered|not\s+provided|unavailable|n\/a)/,
  // "sponsorship is neither offered nor supported"
  new RegExp(`^${AFTER_BRIDGE}(?:is|are)\\s+neither\\b`),
];

/**
 * Text of the clause ending at `index` (bounded by LOOKBEHIND).
 *
 * "not only" is neutralized here rather than at either call site, so the denial
 * path and the affirmative-suppression path agree: "Not only do we sponsor
 * visas, we also cover relocation" is an OFFER, and reading its "not" as a
 * negation would both suppress a real confirmation and forge a denial.
 */
function clauseBefore(masked, index, maxChars = LOOKBEHIND) {
  const from = Math.max(0, index - maxChars);
  const window = masked.slice(from, index);
  let cut = -1;
  for (let i = window.length - 1; i >= 0; i -= 1) {
    if (CLAUSE_BOUNDARY.test(window[i])) { cut = i; break; }
  }
  const start = cut === -1 ? from : from + cut + 1;
  return { text: masked.slice(start, index).replace(/\bnot\s+only\b/g, ' '), start };
}

/** Text of the clause beginning at `index` (bounded by LOOKAHEAD). */
function clauseAfter(masked, index) {
  const window = masked.slice(index, index + LOOKAHEAD);
  const m = CLAUSE_BOUNDARY.exec(window);
  const text = m ? window.slice(0, m.index) : window;
  return { text, end: index + text.length };
}

/**
 * Is the sponsorship term at `index` governed by a STRICT denial? Returns the
 * absolute [start, end) span of the governing prose, or null.
 */
function denialAt(masked, index, length) {
  const before = clauseBefore(masked, index);
  for (const re of DENIAL_BEFORE_RES) {
    const m = re.exec(before.text);
    // Report from where the denial construction actually starts, not from the
    // top of the clause — otherwise the discard reason reads
    // "erver azure / google cloud additional information this role is not
    // eligible for work visa sponsorship" instead of the refusal itself.
    if (m) return { start: before.start + m.index, end: index + length };
  }
  const after = clauseAfter(masked, index + length);
  if (DENIAL_AFTER_RES.some((re) => re.test(after.text))) {
    return { start: index, end: after.end };
  }
  return null;
}

/** Is there a LIBERAL negation cue governing position `index`? */
function negatedAt(masked, index, length) {
  const before = clauseBefore(masked, index, SUPPRESS_LOOKBEHIND);
  if (SUPPRESSING_CUES.some((re) => re.test(before.text))) return true;
  const after = clauseAfter(masked, index + length);
  return DENIAL_AFTER_RES.some((re) => re.test(after.text));
}

/**
 * Does this JD explicitly REFUSE sponsorship?
 *
 * Strict by design (see the module header): a false positive here hard-discards
 * a real job. Returns the matched prose so the discard reason names the actual
 * sentence rather than a config phrase the JD may not contain.
 *
 * @param {unknown} text raw JD / title / any prose
 * @returns {{ denied: boolean, evidence: string[] }}
 */
export function detectSponsorshipDenial(text) {
  const kept = normalizeKeepLines(text);
  if (!kept.trim()) return { denied: false, evidence: [] };
  // Three same-length views of the text, so one index serves all of them:
  //   kept   — line breaks preserved (clause boundaries)
  //   flat   — line breaks as spaces (evidence rendering)
  //   masked — abbreviation periods neutralized (pattern matching)
  const t = flatten(kept);
  const masked = maskAbbreviations(kept);
  const evidence = [];
  SPONSOR_TOPIC_RE.lastIndex = 0;
  let m;
  while ((m = SPONSOR_TOPIC_RE.exec(masked)) !== null) {
    const span = denialAt(masked, m.index, m[0].length);
    if (span) {
      const phrase = t.slice(span.start, span.end).replace(/\s+/g, ' ').trim();
      if (phrase && !evidence.includes(phrase)) evidence.push(phrase);
    }
  }
  return { denied: evidence.length > 0, evidence };
}

/**
 * Affirmative sponsorship phrases that are actually AFFIRMATIVE here — i.e. at
 * least one occurrence is not governed by a negation.
 *
 * A phrase whose every occurrence is negated is reported under `suppressed`, so
 * callers can explain "the JD mentions sponsorship, but only to refuse it"
 * instead of silently returning nothing.
 *
 * @param {unknown} text raw JD prose
 * @param {string[]} phrases scoring.sponsorship.affirmativePhrases
 * @returns {{ affirmed: string[], suppressed: string[] }}
 */
export function affirmativeSponsorshipHits(text, phrases = []) {
  const kept = normalizeKeepLines(text);
  const affirmed = [];
  const suppressed = [];
  if (!kept.trim() || !Array.isArray(phrases)) return { affirmed, suppressed };
  // Phrases are matched against the FLAT view so a phrase that straddles a line
  // break still matches, while boundaries come from the line-preserving view.
  const t = flatten(kept);
  const masked = maskAbbreviations(kept);

  for (const phrase of phrases) {
    const p = flatten(normalizeKeepLines(phrase)).trim();
    if (!p) continue;
    let found = false;
    let clean = false;
    // Walk EVERY occurrence: one un-negated mention is a genuine offer even if
    // the JD also refuses sponsorship elsewhere (the denial path outranks this).
    let from = 0;
    for (;;) {
      const idx = t.indexOf(p, from);
      if (idx === -1) break;
      const boundedLeft = idx === 0 || !/[a-z0-9]/.test(t[idx - 1]);
      const endIdx = idx + p.length;
      const boundedRight = endIdx >= t.length || !/[a-z0-9]/.test(t[endIdx]);
      if (boundedLeft && boundedRight) {
        found = true;
        if (!negatedAt(masked, idx, p.length)) { clean = true; break; }
      }
      from = idx + 1;
    }
    if (clean) affirmed.push(phrase);
    else if (found) suppressed.push(phrase);
  }
  return { affirmed, suppressed };
}

export { SPONSOR_TOPIC_RE };
