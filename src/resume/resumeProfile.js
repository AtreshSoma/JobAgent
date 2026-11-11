/**
 * Read a master resume as PROFILE EVIDENCE, and compare it to what the pipeline
 * is actually searching for.
 *
 * Why this exists
 * ---------------
 * Replacing the master resume changed nothing upstream. `replaceMasterResume`
 * writes the file and keeps a history copy; discovery is driven entirely by
 * `candidate.targetTitles`, and the resume is not read until tailoring time.
 * `scoreJob` even accepts a `resumeKeywords` argument that no caller has ever
 * passed. So uploading a product-manager resume left the system searching for
 * Senior Data Engineer indefinitely, with nothing anywhere saying so.
 *
 * Why this only PROPOSES
 * ----------------------
 * The obvious fix — derive `targetTitles` from the resume automatically — is
 * wrong, and wrong precisely for the person who needs this most. A resume states
 * what someone has DONE; `targetTitles` states what they WANT. Those two
 * diverge exactly when somebody is changing direction, and a career-changer's
 * resume is still full of the field they are leaving. Auto-deriving would search
 * confidently for the wrong thing.
 *
 * config/candidate.json already separates facts (`workHistory`, `technicalStack`)
 * from preferences (`targetTitles`, `locationPreferences`) and that separation is
 * worth keeping. So this module extracts evidence and computes a diff; adopting
 * any of it stays an explicit human act.
 *
 * Everything here is deterministic and reports what it matched. No model, no
 * inference beyond documented text rules.
 */

import { normalizeLoose, normalizeText } from '../utils/textNormalize.js';
import { loadRoleFamilies } from '../profile/roleFamilies.js';

/**
 * Section headings a resume uses, mapped to the kind of evidence beneath them.
 * Matched case-insensitively against a whole short line.
 */
const SECTION_PATTERNS = [
  { kind: 'skills', re: /^(technical\s+)?(skills|core\s+competenc(y|ies)|technical\s+summary|expertise|technologies)$/i },
  { kind: 'experience', re: /^((professional|work|relevant|earlier|additional|previous)\s+)?experience$/i },
  { kind: 'experience', re: /^(employment|work)\s+history$/i },
  { kind: 'summary', re: /^(professional\s+)?(summary|profile|objective|about)$/i },
  // "Education and Professional Development", "Education & Training".
  { kind: 'education', re: /^(education|academic\s+background)(\s*(and|&)\s*[a-z ]+)?$/i },
  { kind: 'certifications', re: /^(certifications?|licenses?|credentials)(\s*(and|&)\s*(certifications?|licenses?|credentials|training))?$/i },
  { kind: 'projects', re: /^((key|selected)\s+)?projects?$/i },
  // Sections nothing extracts from. They still have to be RECOGNISED, or the
  // section above swallows them: an unrecognised "Honors and Awards" made the
  // last job's experience run on through every award line beneath it.
  { kind: 'other', re: /^(honou?rs|awards|achievements|publications|presentations|patents|volunteer(ing)?(\s+experience)?|languages|interests|hobbies|references|affiliations|memberships|activities|leadership|professional\s+(development|affiliations|memberships)|training|courses)(\s*(and|&)\s*[a-z ]+)?$/i },
];

/** A heading is short; a paragraph of prose that happens to start with "Experience" is not. */
const MAX_HEADING_CHARS = 42;

/**
 * Words that appear in a job title but carry no role identity on their own.
 * Used to reject a "title" that is really a fragment.
 */
const TITLE_STOPWORDS = new Set([
  'and', 'of', 'the', 'for', 'to', 'in', 'at', 'with', 'a', 'an', 'senior',
  'lead', 'principal', 'staff', 'junior', 'associate', 'sr', 'jr', 'ii', 'iii',
]);

/**
 * A job title names a ROLE, and roles are named with a small, stable set of
 * nouns. Requiring one is the single rule that separates a title from the three
 * things that otherwise leak in, all verified against real resumes:
 *
 *   - the location line  ("Raleigh, NC   |   April 2022 - Present" -> "Raleigh")
 *   - headline taglines  ("Cloud & Data Platform", "Apache Spark & Lakehouse")
 *   - achievement bullets ("Automated release pipelines with Azure DevOps")
 *
 * Each of those would otherwise become a search term, costing real requests
 * against real job boards and polluting the board with unrelated rows. A title
 * this rule rejects is simply not proposed — the user can still type it — which
 * is the right way for the error to fall.
 */
const BASE_ROLE_NOUNS = [
  'engineer', 'developer', 'analyst', 'architect', 'scientist', 'administrator',
  'manager', 'director', 'consultant', 'specialist', 'lead', 'designer',
  'programmer', 'strategist', 'researcher', 'technician', 'advisor', 'officer',
  'president', 'partner', 'associate', 'intern', 'apprentice', 'fellow',
  'master', 'owner', 'steward', 'modeler', 'modeller', 'statistician',
  'accountant', 'auditor', 'controller', 'recruiter', 'writer', 'editor',
  'marketer', 'salesperson', 'representative', 'coordinator', 'supervisor',
  'head', 'chief', 'vp', 'cto', 'cio', 'ceo', 'devops', 'sre', 'dba',
];

/**
 * Every role noun, drawn from the shared taxonomy so the list covers whatever
 * fields that file describes.
 *
 * The hand-written list above could not read a resume outside office work: it
 * had no 'nurse', 'chef', 'pharmacist', 'electrician', 'paralegal' or
 * 'therapist', so a nurse's resume yielded ZERO titles and the whole
 * resume-to-profile path silently produced an empty proposal. Unioning the
 * `heads` of every family in config/role_families.json fixes that for every
 * profession the taxonomy knows, and adding a field there fixes it for one
 * more — with no edit here.
 */
function allRoleNouns() {
  const nouns = new Set(BASE_ROLE_NOUNS);
  try {
    for (const family of Object.values(loadRoleFamilies().families ?? {})) {
      for (const head of family.heads ?? []) {
        if (!head.includes(' ')) nouns.add(head);
      }
    }
  } catch {
    // A missing taxonomy must not stop a resume being read at all.
  }
  return [...nouns];
}

const ROLE_NOUNS = allRoleNouns();
const ROLE_NOUN_RE = new RegExp(`(?:^|[^a-z])(?:${ROLE_NOUNS.join('|')})(?:[^a-z]|$)`, 'i');

/** "Raleigh, NC" / "Columbus, OH (Remote)" — a place, not a role. */
const PLACE_RE = /^[A-Z][a-zA-Z.\- ]+,\s*[A-Z]{2}\b/;

/** A date range anywhere on the line marks it as the employment-dates line. */
const DATE_LINE_RE = /\b(19|20)\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(19|20)?\d{2}\b|\bpresent\b/i;

/**
 * A date range at the END of a line: "April 2026 - Present", "2019 – 2021",
 * "Aug. 2022 to Aug 2023", "08/2022 - Present".
 */
const TRAILING_DATE_RANGE_RE = new RegExp(
  '[\\s,|–—-]*\\(?\\s*'
  + '(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s+)?(?:\\d{1,2}/)?(?:19|20)\\d{2}'
  + '\\s*(?:[-–—]|to)\\s*'
  + '(?:(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s+)?(?:\\d{1,2}/)?(?:19|20)\\d{2}|present|current|now|date)'
  + '\\s*\\)?\\s*$',
  'i',
);

/** The line with any trailing date range removed. */
export function withoutTrailingDateRange(line) {
  return String(line ?? '').replace(TRAILING_DATE_RANGE_RE, '').trim();
}

/** Achievement bullets start with a past-tense verb, not a role. */
const ACHIEVEMENT_RE = /^(architected|engineered|built|led|orchestrated|designed|developed|implemented|delivered|managed|created|drove|reduced|improved|optimiz|streamlin|deployed|migrated|automated|owned|partnered|collaborated)/i;

/** Seniority prefixes stripped when comparing two titles for the same ROLE. */
const SENIORITY_RE = /^(senior|sr\.?|lead|principal|staff|junior|jr\.?|associate|entry[- ]level|mid[- ]level|head\s+of|chief)\s+/i;

/** Classify one line as a section heading, or null. */
function headingKind(line) {
  const text = line.trim().replace(/[:•\-–—]+$/, '').trim();
  if (!text || text.length > MAX_HEADING_CHARS) return null;
  for (const { kind, re } of SECTION_PATTERNS) {
    if (re.test(text)) return kind;
  }
  return null;
}

/**
 * Split a resume's paragraphs into labelled sections.
 *
 * @param {string[]} paragraphs from `extractDocxText`
 * @returns {Array<{kind: string, lines: string[]}>}
 */
export function splitSections(paragraphs = []) {
  const sections = [];
  // Everything before the first heading is the header block: name, headline,
  // contact line. The headline is often the single best statement of the role.
  let current = { kind: 'header', lines: [] };
  for (const raw of paragraphs) {
    const line = String(raw ?? '').trim();
    if (!line) continue;
    const kind = headingKind(line);
    if (kind) {
      sections.push(current);
      current = { kind, lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  sections.push(current);
  return sections.filter((s) => s.lines.length > 0 || s.kind !== 'header');
}

/**
 * Is this plausibly a job title rather than a bullet or a date line?
 *
 * Conservative on purpose: a false title becomes a search term, which costs
 * real requests against real job boards.
 */
function looksLikeTitle(text, { line = '' } = {}) {
  const t = String(text ?? '').trim();
  if (t.length < 3 || t.length > 70) return false;
  // Bullets, sentences and date lines are not titles. The date test runs on the
  // WHOLE line, not the extracted fragment: "Raleigh, NC | April 2022 - Present"
  // yields the clean-looking "Raleigh" once the date has been split away.
  if (/^[•\-–—*]/.test(t)) return false;
  if (/[.!?]$/.test(t)) return false;
  if (DATE_LINE_RE.test(line || t)) return false;
  if (PLACE_RE.test(t)) return false;
  if (ACHIEVEMENT_RE.test(t)) return false;
  if (/^(present|remote|onsite|hybrid)$/i.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 8) return false;
  // Must name a role (see ROLE_NOUNS) ...
  if (!ROLE_NOUN_RE.test(t)) return false;
  // ... and carry at least one word beyond pure seniority/filler, so a bare
  // "Senior" or "Lead" is not proposed as a search target.
  return words.some((w) => !TITLE_STOPWORDS.has(normalizeText(w).replace(/[^a-z]/g, '')));
}

/**
 * Pull job titles out of the experience sections.
 *
 * Real resumes write the role line one of a few ways, all of which put the
 * TITLE first and the employer after a separator:
 *
 *   "Senior Data Engineer, Finance Analytics & AI Platform | Example Consulting"
 *   "Power BI Developer | Fabrikam Health"
 *   "Migration Specialist — Globex Payroll"
 *
 * So: take the text before the first separator, then before the first comma
 * (which introduces the team/context, not the role).
 */
function titlesFromExperience(sections) {
  const found = [];
  for (const section of sections) {
    if (section.kind !== 'experience') continue;
    for (const raw of section.lines) {
      // "Senior Regulatory CMC Specialist   April 2026 - Present" puts the title
      // and its dates on ONE line. The date guard in looksLikeTitle (which keeps
      // "Raleigh, NC | 2022 - Present" from reading as a title) rejected every
      // such line, so a resume written this way yielded no roles at all and a
      // profile built from it searched for nothing. Strip a trailing range
      // first; a line that was ONLY a place and a date is still caught, because
      // what remains is a place.
      const line = withoutTrailingDateRange(raw);
      const beforeEmployer = line.split(/\s*[|·]\s*|\s+[—–]\s+/)[0];
      const title = beforeEmployer.split(',')[0].trim();
      // Order is preserved. Resumes are reverse-chronological by convention, so
      // the first title found is the most recent role — which is the one that
      // says what this person does NOW.
      if (looksLikeTitle(title, { line })) found.push(tidyTitleCase(title));
    }
  }
  return found;
}

/**
 * The headline under the name ("Data Engineer | Cloud & Data Platform"), which
 * is usually the most deliberate statement of role in the whole document.
 */
function titlesFromHeadline(sections) {
  const header = sections.find((s) => s.kind === 'header');
  if (!header || header.lines.length < 2) return [];
  // Line 0 is the name; the contact line contains an @ or a phone.
  const candidates = header.lines.slice(1, 3)
    .filter((l) => !/@|\d{3}[-.\s]?\d{3,4}/.test(l));
  const out = [];
  for (const line of candidates) {
    for (const part of line.split(/\s*[|·]\s*/)) {
      const t = part.trim();
      if (looksLikeTitle(t, { line })) out.push(tidyTitleCase(t));
    }
  }
  return out;
}

/**
 * Skills from a "Category: a, b, c" skills section.
 *
 * Only the skills section is read. Harvesting terms from bullet prose produced
 * fragments like "data" and "teams" that are useless as match vocabulary.
 */
function skillsFromSections(sections) {
  const out = [];
  for (const section of sections) {
    if (section.kind !== 'skills') continue;
    for (const line of section.lines) {
      // "Cloud & Platform: Azure Databricks, Microsoft Fabric, ..."
      const body = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;
      for (const piece of body.split(/[,;•|]/)) {
        const skill = piece.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
        // One to four words, no sentence punctuation. "Delta Live Tables" yes,
        // "building scalable pipelines for the enterprise" no.
        if (!skill || skill.length < 2 || skill.length > 40) continue;
        if (/[.!?]$/.test(skill)) continue;
        if (skill.split(/\s+/).length > 4) continue;
        out.push(skill);
      }
    }
  }
  return out;
}

/**
 * Normalize a title's CASING for display and for writing into the profile.
 *
 * Resumes style their headings freely — "Data ENGINEER | Cloud & DATA PLATFORM"
 * is real formatting from a real document. Left alone, that shouting is shown
 * back to the user as a suggestion and, worse, written verbatim into
 * `candidate.targetTitles` where it becomes the literal search phrase.
 *
 * Known acronyms are kept upper-case; everything else is title-cased. The list
 * is explicit rather than a length rule, because length does not separate the
 * two: "SENIOR DATA ENGINEER" became "Senior DATA Engineer" when any all-caps
 * token of four characters or fewer was assumed to be an acronym, and DATA,
 * LEAD, FULL and WEB are all ordinary words of that length.
 *
 * @param {string} title
 * @returns {string}
 */
const TITLE_ACRONYMS = new Set([
  'BI', 'SQL', 'ETL', 'ELT', 'AI', 'ML', 'QA', 'QC', 'UX', 'UI', 'HR', 'IT',
  'SRE', 'DBA', 'CRM', 'ERP', 'SEO', 'SEM', 'API', 'VP', 'SVP', 'EVP',
  'CTO', 'CIO', 'CEO', 'CFO', 'COO', 'PM', 'PMO', 'GIS', 'NLP', 'LLM',
  'AWS', 'GCP', 'SAP', 'MDM', 'BA', 'QAE', 'DE', 'ML/AI', 'R&D', 'IOS', 'DEVOPS',
  // Non-office fields name their roles with acronyms too, and a title written
  // "Icu Nurse" becomes a literal search phrase.
  'ICU', 'ER', 'OR', 'RN', 'LPN', 'NP', 'PA', 'EHR', 'EMR', 'CNA', 'EMT',
  'CPA', 'CFA', 'FP&A', 'AML', 'KYC', 'GRC', 'SOC', 'CDL', 'HVAC', 'FDA', 'CAPA',
]);

function tidyTitleCase(title) {
  const text = String(title ?? '');
  // In a title that is NOT shouted in capitals throughout, a short all-caps
  // word is an abbreviation the writer meant ("Regulatory CMC Specialist",
  // "QA Lead"), whatever the profession — the fixed list below cannot know
  // them all. A title in capitals throughout carries no such signal.
  const mixedCase = /[a-z]/.test(text);
  return text
    .split(/(\s+|\/)/)
    .map((token) => {
      if (!/[a-zA-Z]/.test(token)) return token;
      const bare = token.replace(/[^A-Za-z0-9&/+.-]/g, '');
      if (TITLE_ACRONYMS.has(bare.toUpperCase()) && bare === bare.toUpperCase()) return token;
      if (mixedCase && /^[A-Z][A-Z0-9&]{1,4}$/.test(bare)) return token;
      // Leave deliberate mixed case alone ("PySpark", "iOS", "McDonald").
      if (/[a-z]/.test(token) && /[A-Z]/.test(token.slice(1))) return token;
      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    })
    .join('');
}

/** Distinct, order-preserving, compared loosely (case/punctuation-insensitive). */
function distinct(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const key = normalizeLoose(v);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(String(v).trim());
  }
  return out;
}

/**
 * Extract role and skill evidence from a master resume's text.
 *
 * @param {string[]} paragraphs from `extractDocxText(...).paragraphs`
 * @returns {{
 *   titles: string[], headlineTitles: string[], skills: string[],
 *   sections: Array<{kind: string, lines: number}>
 * }}
 */
export function extractResumeEvidence(paragraphs = []) {
  const sections = splitSections(paragraphs);
  const headlineTitles = distinct(titlesFromHeadline(sections));
  const experienceTitles = distinct(titlesFromExperience(sections));

  // CURRENT vs EARLIER is the distinction that makes this evidence usable.
  //
  // A resume is a career history, so most of the titles in it are roles the
  // person has already moved past. Treating all of them as equally live made a
  // perfectly aligned resume look mismatched: a Senior Data Engineer whose
  // profile targets exactly that was reported as "disagreeing" with its own job
  // search, because five roles last held in 2017-2021 outnumbered the two
  // current ones and dragged a flat coverage count to 29%.
  //
  // Current = what the headline claims + the most recent position. Everything
  // else is history: still worth showing, never a reason to say the two
  // documents describe different jobs.
  const currentTitles = distinct([...headlineTitles, ...experienceTitles.slice(0, 1)]);
  const earlierTitles = distinct(experienceTitles.slice(1))
    .filter((t) => !currentTitles.some((c) => normalizeLoose(c) === normalizeLoose(t)));

  return {
    // Headline first: it is the candidate's own statement of what they are.
    titles: distinct([...headlineTitles, ...experienceTitles]),
    headlineTitles,
    currentTitles,
    earlierTitles,
    skills: distinct(skillsFromSections(sections)),
    sections: sections.map((s) => ({ kind: s.kind, lines: s.lines.length })),
  };
}

/** Compare two titles ignoring seniority, so "Senior Data Engineer" ~ "Data Engineer". */
function roleKey(title) {
  return normalizeLoose(String(title ?? '').replace(SENIORITY_RE, ''));
}

/**
 * Does the configured target list already cover this resume title?
 *
 * Covered means the same role at any seniority, or one title containing the
 * other as a whole phrase ("Data Engineer" covers "Azure Data Engineer").
 */
function coveredBy(title, targetTitles) {
  const key = roleKey(title);
  if (!key) return null;
  for (const target of targetTitles) {
    const tKey = roleKey(target);
    if (!tKey) continue;
    if (tKey === key || tKey.includes(key) || key.includes(tKey)) return target;
  }
  return null;
}

/**
 * Compare resume evidence with the profile that actually drives discovery.
 *
 * @param {object} evidence from `extractResumeEvidence`
 * @param {object} candidate parsed config/candidate.json
 * @returns {{
 *   matchedTitles: Array<{title: string, coveredBy: string}>,
 *   newTitles: string[],
 *   unusedTargets: string[],
 *   newSkills: string[],
 *   coverage: number,
 *   drifted: boolean,
 *   summary: string
 * }}
 */
export function diffAgainstProfile(evidence, candidate = {}) {
  const targetTitles = Array.isArray(candidate.targetTitles) ? candidate.targetTitles : [];
  const stack = candidate.technicalStack ?? {};
  const knownSkills = new Set(
    Object.values(stack).flat().filter(Boolean).map((s) => normalizeLoose(s)),
  );

  const matchedTitles = [];
  const newTitles = [];
  for (const title of evidence.titles) {
    const cover = coveredBy(title, targetTitles);
    if (cover) matchedTitles.push({ title, coveredBy: cover });
    else newTitles.push(title);
  }

  // Targets the resume shows no evidence for. Not necessarily wrong — you may
  // be targeting a role you have not held — but worth surfacing next to the
  // rest, because it is the other half of "do these two agree?".
  const evidenceKeys = evidence.titles.map(roleKey);
  const unusedTargets = targetTitles.filter(
    (t) => !evidenceKeys.some((k) => k && (k === roleKey(t) || k.includes(roleKey(t)) || roleKey(t).includes(k))),
  );

  const newSkills = evidence.skills.filter((s) => !knownSkills.has(normalizeLoose(s)));

  const coverage = evidence.titles.length
    ? matchedTitles.length / evidence.titles.length
    : 1;

  // DRIFT IS A QUESTION ABOUT THE CURRENT ROLE, NOT A HEAD COUNT.
  //
  // This used to be "fewer than half of all titles match". That is wrong on any
  // real resume, because a resume is a career history: most of its titles are
  // roles already moved past. Measured on a genuine Senior Data Engineer resume
  // against a profile targeting exactly "Senior Data Engineer" and "Data
  // Engineer", the two current roles matched and five roles last held in
  // 2017-2021 did not, giving 29% coverage — and the panel announced that the
  // resume and the job search "disagree" when they agreed completely.
  //
  // They disagree only when NOTHING the person currently claims to be is being
  // searched for. That is the career-change case this is meant to catch, and it
  // is the only case where "uploading this changed nothing" is a warning rather
  // than a note.
  const currentTitles = Array.isArray(evidence.currentTitles) && evidence.currentTitles.length
    ? evidence.currentTitles
    : evidence.titles.slice(0, 1);
  const currentCovered = currentTitles.filter((t) => coveredBy(t, targetTitles));
  const drifted = currentTitles.length > 0 && currentCovered.length === 0;

  const earlierUnmatched = newTitles.filter(
    (t) => !currentTitles.some((c) => normalizeLoose(c) === normalizeLoose(t)),
  );

  let summary;
  if (drifted) {
    summary = `This resume presents you as ${currentTitles.map((t) => `"${t}"`).join(' / ')}, `
      + `but discovery is searching for ${targetTitles.slice(0, 3).map((t) => `"${t}"`).join(', ')}`
      + `${targetTitles.length > 3 ? ` and ${targetTitles.length - 3} more` : ''}. `
      + 'Discovery follows the profile, not the resume — nothing changes until you adopt a title.';
  } else if (earlierUnmatched.length) {
    summary = `Your current role (${currentCovered.map((t) => `"${t}"`).join(' / ')}) is already being `
      + `searched for. ${earlierUnmatched.length} earlier role(s) in this resume are not — `
      + 'add them only if you would still take that kind of job.';
  } else {
    summary = `Your current role (${currentCovered.map((t) => `"${t}"`).join(' / ')}) is already being `
      + 'searched for, and so is every other role in this resume.';
  }

  return {
    matchedTitles,
    newTitles,
    currentTitles,
    currentCovered,
    earlierUnmatched,
    unusedTargets,
    newSkills,
    coverage,
    drifted,
    summary,
  };
}
