/**
 * Resume -> candidate background, and "is this even the same person?".
 *
 * WHAT THIS DOES AND DELIBERATELY DOES NOT DO
 * -------------------------------------------
 * It fills `profile.background` outright — that half of the profile IS a record
 * of the resume, so reading it from the resume is not a guess.
 *
 * It only PROPOSES `profile.searchIntent`. A resume says what someone has done;
 * an intent says what they want next, and those diverge exactly when somebody
 * is changing direction. Auto-deriving the search from the resume would search
 * confidently for the field a career-changer is trying to leave. So the
 * proposal is returned for a human to accept, edit or decline, and nothing is
 * written here.
 *
 * Everything is deterministic text analysis and reports what it matched. No
 * model, no inference beyond the documented rules below.
 */

import { normalizeText, normalizeLoose } from '../utils/textNormalize.js';
import { extractResumeEvidence, splitSections } from '../resume/resumeProfile.js';
import { profileFamilies, scoreFamilies, stripSeniority, significantTokens, tokensRelate } from './roleFamilies.js';
import { normalizeProfile, seniorityKey, distinct, slugify } from './model.js';

/** A year range anywhere on a line, used for tenure arithmetic. */
const YEAR_RE = /\b(19[89]\d|20[0-4]\d)\b/g;

/** "Present", "Current" and friends mean "up to now". */
const PRESENT_RE = /\b(present|current|now|to\s*date)\b/i;

/** "8+ years of experience", "over 10 years" — a stated total beats arithmetic. */
const STATED_YEARS_RE = /\b(?:over|more\s+than|nearly|about|approx(?:imately)?\.?\s*)?(\d{1,2})\s*\+?\s*years?\b[^.]{0,40}\b(?:of\s+)?(?:progressive\s+|professional\s+|hands[- ]on\s+|relevant\s+)?experience\b/i;

/** Lines that evidence people leadership. Phrasing, not job title. */
const LEADERSHIP_RE = [
  /\b(led|leading|lead)\s+(a\s+)?(team|group|squad|crew|staff|department|function)/i,
  /\bmanaged\s+(a\s+)?(team|group|staff|\d+\s+(direct\s+reports?|people|engineers|analysts|nurses|associates))/i,
  /\b\d+\s+direct\s+reports?\b/i,
  /\b(mentor|mentored|mentoring|coached|supervised|supervising)\b/i,
  /\b(hired|hiring|recruited|onboarded)\s+(and\s+\w+\s+)?(engineers|analysts|staff|team|associates)/i,
  /\b(owned|ownership\s+of)\s+the\s+(roadmap|strategy|budget|p&l)/i,
];

/** Credential lines look like these. Kept broad — every field names its own. */
const CERT_HINT_RE = /\b(certified|certificate|certification|licence|license|licensed|credential|accredited|registered|chartered|board[- ]certified)\b/i;

/**
 * Industry words worth recording when a resume names them. This is the ONE
 * list here that is vocabulary rather than structure, and it is industries —
 * which are the same set for every profession, unlike skills or titles.
 */
const INDUSTRY_TERMS = [
  'healthcare', 'hospital', 'clinical', 'pharmaceutical', 'pharma', 'biotech', 'medical device',
  'finance', 'financial services', 'banking', 'insurance', 'fintech', 'capital markets',
  'retail', 'e-commerce', 'ecommerce', 'consumer goods', 'hospitality', 'travel',
  'manufacturing', 'automotive', 'aerospace', 'defense', 'energy', 'oil and gas', 'utilities',
  'telecommunications', 'media', 'entertainment', 'gaming', 'advertising',
  'government', 'public sector', 'nonprofit', 'non-profit', 'education', 'higher education',
  'logistics', 'supply chain', 'transportation', 'real estate', 'construction',
  'agriculture', 'legal services', 'consulting', 'saas', 'technology', 'cybersecurity',
];

/**
 * Read a resume into the EVIDENCE half of a profile.
 *
 * @param {string[]} paragraphs from `extractDocxText(...).paragraphs`
 * @param {object} [options]
 * @param {string} [options.sourceFile] recorded for provenance
 * @param {Date} [options.now]
 * @returns {object} a `profile.background`, plus `name` when the resume states one
 */
export function buildBackground(paragraphs = [], { sourceFile = '', now = new Date() } = {}) {
  const evidence = extractResumeEvidence(paragraphs);
  const sections = splitSections(paragraphs);
  const allText = paragraphs.join('\n');

  return {
    source: 'resume',
    sourceFile,
    extractedAt: now.toISOString(),
    currentRoles: evidence.currentTitles ?? [],
    earlierRoles: evidence.earlierTitles ?? [],
    yearsExperience: yearsOfExperience(allText, sections, now),
    seniority: inferSeniority(evidence.currentTitles ?? [], allText),
    skills: evidence.skills ?? [],
    industries: industriesIn(allText),
    certifications: certificationsIn(sections),
    education: educationIn(sections),
    workHistory: workHistoryIn(sections),
    leadership: leadershipIn(allText),
    // Not part of the stored background — returned so the caller can ask
    // "is this the same person?" before overwriting anything.
    _name: nameFrom(sections),
    _headline: (evidence.headlineTitles ?? [])[0] ?? '',
  };
}

/**
 * Total years of professional experience.
 *
 * A summary line that STATES a number is trusted over arithmetic, because it is
 * the candidate's own claim and it already accounts for gaps, part-time work
 * and careers that started before the resume's earliest listed role. Failing
 * that, the span from the earliest employment year to the latest (or now, when
 * a role says "Present") is used.
 */
export function yearsOfExperience(text, sections, now = new Date()) {
  const stated = STATED_YEARS_RE.exec(text);
  if (stated) {
    const years = Number(stated[1]);
    if (years > 0 && years <= 60) return years;
  }
  const experience = sections.filter((s) => s.kind === 'experience').flatMap((s) => s.lines);
  if (!experience.length) return null;

  // TIME WORKED, NOT TIME ELAPSED.
  //
  // This used to be `max(allYears) - min(allYears)`, which counts every gap
  // between jobs as experience. Measured on a resume showing 2010–2011 and
  // 2024–2026 — three years of work with a thirteen-year gap — it reported
  // 16 years, and that number flows into the "years of experience" screening
  // answer and the cover letter's opening sentence.
  //
  // Each line contributes the range IT states; overlapping ranges (concurrent
  // or consecutive roles listed separately) are merged so they are not counted
  // twice, and the merged total is the answer.
  const ranges = [];
  const thisYear = now.getFullYear();
  for (const line of experience) {
    const found = (line.match(YEAR_RE) ?? []).map(Number).filter((y) => y <= thisYear);
    if (!found.length) continue;
    const start = Math.min(...found);
    // "2019 – Present" ends now; a line naming one year is that year's work.
    const end = PRESENT_RE.test(line) ? thisYear : Math.max(...found);
    if (end >= start) ranges.push([start, end]);
  }
  if (!ranges.length) return null;

  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0].slice()];
  for (const [start, end] of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    // Touching ranges (2018–2021 then 2021–2024) are one continuous stretch.
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const span = merged.reduce((total, [start, end]) => total + (end - start), 0);
  return span > 0 && span <= 60 ? span : null;
}

/**
 * Seniority claimed by the CURRENT role, falling back to years served.
 *
 * Current-role-first matters: a resume that shows a Junior title from 2014 and
 * a Principal title today is a principal, and counting all titles equally would
 * read it as somewhere in the middle.
 */
export function inferSeniority(currentRoles, text) {
  for (const role of currentRoles) {
    const tokens = normalizeText(role).split(/\s+/);
    for (const token of tokens) {
      const key = seniorityKey(token);
      if (key) return key;
    }
  }
  const stated = STATED_YEARS_RE.exec(text ?? '');
  const years = stated ? Number(stated[1]) : null;
  if (years === null) return null;
  if (years < 2) return 'entry';
  if (years < 5) return 'mid';
  if (years < 10) return 'senior';
  return 'lead';
}

/** Industries the resume names. */
export function industriesIn(text) {
  const haystack = normalizeText(text);
  const found = INDUSTRY_TERMS.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack);
  });
  return distinct(found.map((t) => t.replace(/\b\w/g, (c) => c.toUpperCase())));
}

/** Certification / licence lines. */
export function certificationsIn(sections) {
  const out = [];
  for (const section of sections) {
    if (section.kind === 'certifications') {
      for (const line of section.lines) {
        for (const piece of line.split(/[,;|•]/)) {
          const value = piece.replace(/\s+/g, ' ').trim();
          if (value.length >= 2 && value.length <= 120) out.push(value);
        }
      }
    } else {
      // A credential named in the header or summary still counts.
      for (const line of section.lines) {
        if (line.length <= 120 && CERT_HINT_RE.test(line)) out.push(line.replace(/\s+/g, ' ').trim());
      }
    }
  }
  return distinct(out, 40);
}

/** Education entries, parsed loosely — resumes format these freely. */
export function educationIn(sections) {
  const out = [];
  for (const section of sections) {
    if (section.kind !== 'education') continue;
    for (const line of section.lines) {
      const text = line.replace(/\s+/g, ' ').trim();
      if (!text || text.length > 200) continue;
      const year = (text.match(/\b(19[5-9]\d|20[0-4]\d)\b/) ?? [])[0] ?? '';
      const [head, ...rest] = text.split(/\s*[|,–—-]\s*/);
      const degreeLike = /\b(bachelor|master|associate|doctor|phd|ph\.d|mba|b\.?s|m\.?s|b\.?a|m\.?a|diploma|certificate)\b/i;
      const degreePart = [head, ...rest].find((p) => degreeLike.test(p)) ?? '';
      const institution = [head, ...rest].find((p) => p && p !== degreePart && !/^\d{4}$/.test(p.trim())) ?? head ?? '';
      // "Master of Science in Computer Science" is a degree AND a field; the
      // eligibility gate and the application form each want one of them.
      const degreeText = String(degreePart).trim();
      const split = /^(.*?\b(?:bachelor|master|associate|doctor)\w*(?:'s)?(?:\s+of\s+[A-Za-z]+)?)\s+in\s+(.+)$/i.exec(degreeText);
      out.push({
        institution: String(institution).trim(),
        degree: split ? split[1].trim() : degreeText,
        field: split ? split[2].replace(/\s*\(.*$/, '').trim() : '',
        graduationYear: year,
      });
    }
  }
  return out.slice(0, 20);
}

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const DATE_POINT = `(?:${MONTH}\\s+)?(?:19|20)\\d{2}`;
/** "April 2022 - Present", "2019 – 2021", "Jan 2020 to Mar 2022". */
const DATE_RANGE_RE = new RegExp(`(${DATE_POINT})\\s*(?:[-–—]|to)\\s*(${DATE_POINT}|present|current|now)`, 'i');
/** An achievement bullet opens with a past-tense verb ("Architected", "Led", "Built"). */
const ACHIEVEMENT_RE = /^(?:[•▪◦·*-]\s*)?(?:[A-Z][a-z]+ed|Built|Led|Ran|Won|Grew|Drove|Made|Cut|Set|Wrote|Taught|Oversaw|Shipped|Mentored|Brought|Sold|Held|Kept|Spun|Leads?|Owns?|Drives?|Builds?|Manages?|Designs?)\b/;

/**
 * The roles on the resume: employer, title, place, dates and the first few
 * achievement bullets, copied VERBATIM.
 *
 * A role opens with a header line ("Senior Data Engineer, Finance Analytics |
 * Capgemini America") followed by a line holding a date range ("Raleigh, NC
 * (Remote) | April 2022 - Present"); either order of the two halves is read.
 * Nothing is paraphrased or inferred — a field the resume does not state is
 * left empty, which is what lets the profile carry the resume's own words
 * instead of the template's "Example Corp" (the placeholders that blocked
 * every application on 2026-09-23).
 *
 * @param {Array<{kind: string, lines: string[]}>} sections
 * @returns {Array<{employer: string, title: string, location: string, startDate: string, endDate: string, current: boolean, highlights: string[]}>}
 */
export function workHistoryIn(sections) {
  const roles = [];
  const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
  for (const section of sections) {
    if (section.kind !== 'experience') continue;
    const lines = section.lines.map(clean).filter(Boolean);
    for (let i = 0; i < lines.length - 1; i += 1) {
      const dates = DATE_RANGE_RE.exec(lines[i + 1]);
      if (!dates || DATE_RANGE_RE.test(lines[i]) || lines[i].length > 160) continue;
      // Header: "Title, Team | Employer (note)" — the employer is the side
      // after the bar; without a bar, "Title at Employer" / "Title — Employer".
      const header = lines[i];
      let [titlePart, employerPart] = header.includes('|')
        ? header.split('|').map(clean)
        : header.split(/\s+(?:at|@|—|–)\s+/).map(clean);
      employerPart = clean(String(employerPart ?? '').replace(/\([^)]*\)/g, ''));
      const title = clean(String(titlePart ?? '').split(',')[0]);
      if (!title || !employerPart) continue;
      const location = clean(lines[i + 1].replace(dates[0], '').replace(/[|,–—-]\s*$/, '').replace(/\s*\|\s*$/, ''));
      const end = dates[2];
      const current = /present|current|now/i.test(end);
      const highlights = [];
      for (let j = i + 2; j < lines.length && highlights.length < 3; j += 1) {
        if (j + 1 < lines.length && DATE_RANGE_RE.test(lines[j + 1])) break; // next role
        if (ACHIEVEMENT_RE.test(lines[j]) && lines[j].length >= 40) highlights.push(lines[j].replace(/^[•▪◦·*-]\s*/, ''));
      }
      roles.push({
        employer: employerPart,
        title,
        location: location.replace(/^\||\|$/g, '').trim(),
        startDate: clean(dates[1]),
        endDate: current ? '' : clean(end),
        current,
        highlights,
      });
      i += 1;
    }
  }
  return roles.slice(0, 30);
}

/** People-leadership evidence, with the lines that produced it. */
export function leadershipIn(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const evidence = [];
  for (const line of lines) {
    if (LEADERSHIP_RE.some((re) => re.test(line))) {
      evidence.push(line.replace(/\s+/g, ' ').trim().slice(0, 200));
    }
    if (evidence.length >= 10) break;
  }
  return { hasManaged: evidence.length > 0, evidence };
}

/** The name at the top of the resume, if the header states one. */
export function nameFrom(sections) {
  const header = sections.find((s) => s.kind === 'header');
  const first = header?.lines?.[0]?.trim() ?? '';
  if (!first || first.length > 60) return '';
  if (/@|\d{3}/.test(first)) return ''; // a contact line, not a name
  const words = first.split(/\s+/);
  if (words.length < 2 || words.length > 5) return '';
  return first;
}

/* ───────────────────── is this the same person? ───────────────────── */

/**
 * Compare a freshly-parsed resume against the ACTIVE profile.
 *
 * This is what stops the tool from silently searching with one person's titles
 * after another person's resume has been uploaded. It answers with one of:
 *
 *   same       the same person, no meaningful change
 *   evolved    the same person, but the resume has moved on (new roles/skills)
 *   different  this looks like a DIFFERENT candidate
 *
 * The name is decisive when both documents state one — nothing else comes close
 * as evidence, and two people in the same field would otherwise read as "same".
 * Without a name it falls back to role-family and skill overlap, which catches
 * the case the whole feature exists for: a completely different profession.
 *
 * @param {object} background from `buildBackground`
 * @param {object} activeProfile the currently active normalized profile
 * @param {object} taxonomy role families
 * @returns {{relation, confidence, reasons: string[], summary, familyOverlap, skillOverlap}}
 */
export function compareToActiveProfile(background = {}, activeProfile = null, taxonomy = { families: {} }) {
  if (!activeProfile) {
    return {
      relation: 'different',
      confidence: 'certain',
      reasons: ['no search profile is active yet'],
      summary: 'No search profile exists yet, so this resume has nothing to be compared against.',
      familyOverlap: 0,
      skillOverlap: 0,
    };
  }

  const reasons = [];
  const resumeName = normalizeLoose(background._name ?? '');
  const profileName = normalizeLoose(activeProfile.identity?.fullName ?? '');
  let nameVerdict = null;
  if (resumeName && profileName) {
    nameVerdict = resumeName === profileName ? 'same' : 'different';
    reasons.push(nameVerdict === 'same'
      ? `the resume names ${background._name}, which matches the active profile`
      : `the resume names ${background._name}, but the active profile is ${activeProfile.identity.fullName}`);
  }

  // Family overlap, measured on what the RESUME evidences against the families
  // the active profile searches in.
  const resumeFamilies = scoreFamilies(
    [...(background.currentRoles ?? []), ...(background.skills ?? []), ...(background.industries ?? [])].join(' . '),
    taxonomy,
  ).filter((f) => f.score >= 6).map((f) => f.id);
  const profileFams = profileFamilies(activeProfile, taxonomy).map((f) => f.id);
  const shared = resumeFamilies.filter((f) => profileFams.includes(f));
  const familyOverlap = resumeFamilies.length ? shared.length / resumeFamilies.length : 0;

  // DEDUPE BEFORE COUNTING. `skillsToKeep` and `background.skills` overlap by
  // design, so counting the raw concatenation against a deduplicated
  // denominator produced ratios above 1 — the panel read "94 of 47 profile
  // skills appear in this resume", which is visibly nonsense and quietly made
  // `skillOverlap` useless as a signal for the same/evolved/different verdict.
  const resumeSkills = new Set((background.skills ?? []).map((s) => normalizeLoose(s)));
  const profileSkills = new Set([
    ...(activeProfile.searchIntent?.skillsToKeep ?? []),
    ...(activeProfile.background?.skills ?? []),
  ].map((s) => normalizeLoose(s)).filter(Boolean));
  const sharedSkills = [...profileSkills].filter((s) => resumeSkills.has(s));
  const skillOverlap = profileSkills.size ? sharedSkills.length / profileSkills.size : 0;

  if (resumeFamilies.length) {
    reasons.push(shared.length
      ? `both describe ${shared.map((f) => taxonomy.families?.[f]?.label ?? f).join(', ')} work`
      : `the resume describes ${resumeFamilies.map((f) => taxonomy.families?.[f]?.label ?? f).join(', ')} work, `
        + `while the active profile searches ${profileFams.map((f) => taxonomy.families?.[f]?.label ?? f).join(', ') || 'nothing recognizable'}`);
  }
  reasons.push(`${sharedSkills.length} of ${profileSkills.size} profile skills appear in this resume`);

  let relation;
  let confidence;
  if (nameVerdict === 'different') {
    relation = 'different';
    confidence = 'high';
  } else if (familyOverlap === 0 && resumeFamilies.length > 0) {
    relation = 'different';
    confidence = nameVerdict === 'same' ? 'low' : 'high';
    // Same name in a completely different field is a CAREER CHANGE, not a new
    // person — and the right offer there is still "build a new search", so the
    // relation is the same while the confidence is not.
    if (nameVerdict === 'same') reasons.push('the name matches, so this is more likely a career change than a different person');
  } else if (skillOverlap < 0.34 || familyOverlap < 0.5) {
    relation = 'evolved';
    confidence = 'medium';
  } else {
    relation = 'same';
    confidence = 'high';
  }

  const summary = {
    same: 'This resume matches the active search profile. Nothing needs to change.',
    evolved: 'This looks like the same person, but the resume has moved on from what the active profile searches for.',
    different: 'This resume does not match the active search profile — it appears to describe a different candidate or a different career.',
  }[relation];

  return { relation, confidence, reasons, summary, familyOverlap, skillOverlap };
}

/**
 * Propose a `searchIntent` from a resume, for a human to confirm.
 *
 * The proposal is the CONSERVATIVE reading: target the roles the person
 * currently holds, at the level they currently are, keeping the skills they
 * currently use. That is the right default for someone continuing their career
 * and the wrong one for someone changing it — which is exactly why it is
 * offered rather than applied.
 *
 * Preferences a resume cannot know (locations, work mode, pay, sponsorship) are
 * carried over from the existing intent when there is one, and otherwise left
 * empty for the user to state. They are never invented.
 *
 * @param {object} background
 * @param {object} [options]
 * @param {object} [options.currentIntent] the active profile's intent, if any
 * @returns {{intent: object, carriedOver: string[], proposed: string[]}}
 */
export function proposeSearchIntent(background = {}, { currentIntent = null, samePerson = true } = {}) {
  const roles = distinct([...(background.currentRoles ?? []), ...(background.earlierRoles ?? []).slice(0, 2)]);
  const proposed = ['targetRoles', 'seniority', 'skillsToKeep', 'industries'];
  const carriedOver = [];

  const intent = {
    targetRoles: roles,
    seniority: background.seniority ?? '',
    skillsToKeep: background.skills ?? [],
    industries: background.industries ?? [],
    skillsToGrow: [],
    roleFamilies: [],
  };

  // Preferences a resume genuinely cannot state. Inheriting these from the
  // active profile is right for the SAME person building a second search and
  // wrong for anybody else.
  const SEARCH_PREFERENCES = [
    'locations', 'workModes', 'employmentTypes', 'minContractMonths',
    'excludedLocations', 'excludedEmployers', 'excludedTerms', 'usOnly',
  ];

  /**
   * Facts about a PERSON, not about a search.
   *
   * These were inherited alongside the preferences above, so creating a profile
   * from a second person's resume adopted the first person's work
   * authorization, salary expectation, start date and relocation terms — and
   * every one of those is typed verbatim onto an employer's form. Sponsorship
   * is the sharpest case: the new candidate's application would have stated the
   * previous candidate's immigration status.
   *
   * They are inherited only when the resume names the SAME person the active
   * profile describes. Otherwise they start empty and the new profile has to be
   * told, which is a question the user can answer and this code cannot.
   */
  const PERSONAL_FACTS = ['compensation', 'workAuthorization', 'relocation', 'travel', 'startDate'];

  const inherit = samePerson ? [...SEARCH_PREFERENCES, ...PERSONAL_FACTS] : SEARCH_PREFERENCES;
  for (const key of inherit) {
    if (currentIntent && currentIntent[key] !== undefined) {
      intent[key] = currentIntent[key];
      carriedOver.push(key);
    }
  }

  return { intent, carriedOver, proposed, samePerson };
}

/**
 * Does this resume name the same person the active profile describes?
 *
 * Decided on the NAME alone, and only when both documents state one. Role and
 * skill overlap says what field somebody works in, not who they are — two
 * nurses are not one nurse — so it must never be allowed to authorize copying
 * personal facts. Unknown is treated as "not the same person": the cost of
 * being wrong that way is a user re-entering their own salary expectation,
 * while the other way it is somebody else's visa status on a real application.
 *
 * @param {object} background from `buildBackground`
 * @param {object|null} currentProfile
 * @returns {boolean}
 */
export function namesSamePerson(background = {}, currentProfile = null) {
  const resumeName = normalizeLoose(background._name ?? '');
  const profileName = normalizeLoose(currentProfile?.identity?.fullName ?? '');
  if (!resumeName || !profileName) return false;
  return resumeName === profileName;
}

/**
 * Build a complete, ready-to-save profile from a resume.
 *
 * @param {string[]} paragraphs
 * @param {object} [options]
 * @param {object} [options.currentProfile] active profile, for inherited preferences
 * @param {string} [options.label]
 * @param {string} [options.sourceFile]
 * @returns {object} normalized profile
 */
export function profileFromResume(paragraphs, {
  currentProfile = null, label, sourceFile = '', now = new Date(), existingIds = [],
} = {}) {
  const background = buildBackground(paragraphs, { sourceFile, now });
  const samePerson = namesSamePerson(background, currentProfile);
  const { intent } = proposeSearchIntent(background, {
    currentIntent: currentProfile?.searchIntent ?? null,
    samePerson,
  });
  const name = background._name || currentProfile?.identity?.fullName || '';
  const headline = background._headline || background.currentRoles?.[0] || '';
  const stored = { ...background };
  delete stored._name;
  delete stored._headline;

  return normalizeProfile({
    // A resume-derived id used to be the candidate's NAME alone, so the same
    // person's second search direction produced the same id and `saveProfile`
    // replaced the profile they already had — losing the search goals this
    // feature promises to keep switchable. The id now steps aside from any id
    // already on disk instead of overwriting it.
    id: uniqueProfileId(slugify(label || name || 'resume-profile'), existingIds),
    label: label || (name ? `${name} — ${headline || 'search'}` : 'Profile from resume'),
    identity: {
      fullName: name,
      preferredName: name.split(/\s+/)[0] ?? '',
      headline,
      // Somebody else's LinkedIn and portfolio are as personal as their phone
      // number, and these are carried onto applications. Same rule as contact.
      links: samePerson ? (currentProfile?.identity?.links ?? {}) : {},
    },
    // Contact details and address are personal facts a resume DOES state, but
    // carrying them from the previous profile would attach one person's phone
    // number to another person's application. They start empty unless the
    // resume is the same person's — in which case re-typing details the tool
    // already holds about them is pure friction.
    contact: samePerson ? (currentProfile?.contact ?? {}) : {},
    location: samePerson ? (currentProfile?.location ?? {}) : {},
    background: stored,
    searchIntent: intent,
  });
}

/**
 * An id that does not collide with one already saved.
 *
 * "Create a profile" must CREATE one. `saveProfile` writes by id and replaces
 * whatever is there, so a name-derived id meant a second search built from the
 * same person's resume silently overwrote their first — the previous profile
 * was promised to stay available and did not.
 *
 * @param {string} base slugified preferred id
 * @param {string[]} existingIds ids already on disk
 * @returns {string}
 */
export function uniqueProfileId(base, existingIds = []) {
  const taken = new Set((existingIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean));
  const root = slugify(base);
  if (!taken.has(root)) return root;
  for (let n = 2; n <= 99; n += 1) {
    const candidate = slugify(`${root}-${n}`);
    if (!taken.has(candidate)) return candidate;
  }
  return slugify(`${root}-${Date.now().toString(36)}`);
}

/** Do two role strings name the same role, ignoring level and word forms? */
export function rolesMatch(a, b) {
  const left = significantTokens(stripSeniority(a));
  const right = significantTokens(stripSeniority(b));
  if (!left.length || !right.length) return false;
  const shared = left.filter((t) => right.some((r) => tokensRelate(t, r)));
  return shared.length >= Math.min(left.length, right.length);
}
