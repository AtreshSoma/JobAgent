/**
 * The Candidate Profile — two halves that must never be conflated.
 *
 *   background    EVIDENCE. What this person has done, inferred from their
 *                 resume: roles held, years, skills, industries, seniority,
 *                 education, certifications, leadership.
 *
 *   searchIntent  PREFERENCE. What they want NEXT, stated by them: target
 *                 roles, desired level, locations, work mode, employment type,
 *                 industries, compensation, work authorization, and the skills
 *                 they want to keep using or move toward.
 *
 * WHY THE SPLIT IS LOAD BEARING. A resume states what someone HAS DONE;
 * a job search states what they WANT. Those diverge exactly when somebody is
 * changing direction, and a career-changer's resume is still full of the field
 * they are leaving. Deriving the search from the resume automatically would
 * therefore search confidently for the wrong thing, for the very person who
 * most needs this to work. So resume parsing only ever PROPOSES: it fills
 * `background` outright (that is a factual record) and proposes `searchIntent`
 * for a human to accept, edit or decline.
 *
 * The reverse error matters too, which is why `background` exists at all rather
 * than the intent being the only thing stored. Scoring needs to know what the
 * person can actually evidence — a role they want but cannot support is a
 * different situation from one they are already doing, and the dashboard should
 * be able to say which it is looking at.
 *
 * DERIVED, NOT DUPLICATED. `toCandidateConfig` projects a profile down onto the
 * legacy `config/candidate.json` shape, which is what every existing consumer
 * (form filler, scorer, adapters, cover letter, doctor) already reads. That
 * keeps this a re-architecture rather than a rewrite: the profile becomes the
 * source of truth and candidate.json becomes a generated view of it.
 */

import { normalizeText } from '../utils/textNormalize.js';

/** Bumped when the stored shape changes in a way a reader must notice. */
export const PROFILE_VERSION = 1;

/** Seniority keys a profile may state. Ordered low to high. */
export const SENIORITY_KEYS = Object.freeze([
  'intern', 'entry', 'associate', 'mid', 'senior', 'lead', 'principal', 'director', 'executive',
]);

/** Work arrangements a search may ask for. */
export const WORK_MODES = Object.freeze(['remote', 'hybrid', 'onsite']);

/** Caps, so a malformed or hostile profile can never explode a run. */
export const LIMITS = Object.freeze({
  targetRoles: 40, skills: 300, industries: 40, locations: 40, roles: 60,
  textField: 300, list: 400,
});

const str = (v, max = LIMITS.textField) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const bool = (v, fallback = false) => (typeof v === 'boolean' ? v : fallback);
/**
 * A boolean, or null when the profile never stated one.
 *
 * WHY THIS IS NOT `bool()`. `requiresSponsorship` is a statement about a
 * person's immigration status that gets typed verbatim onto employers' forms.
 * Defaulting it to `false` turned "this profile says nothing" into "No, I do
 * not require visa sponsorship" — measured, a profile supplying only
 * `status: 'US Citizen'` and omitting the boolean answered exactly that. A
 * guess about immigration status is not a safe default in either direction, so
 * an unstated value stays unstated all the way down and the question falls
 * through to the human.
 */
const triBool = (v) => (typeof v === 'boolean' ? v : null);
/** A number only when it is meaningfully greater than zero. */
const positive = (v) => (Number.isFinite(v) && v > 0 ? v : null);
/**
 * A number, or null when the value is genuinely absent.
 *
 * `Number(null)` is 0 and `Number('')` is 0, both finite — so the obvious
 * one-liner turned "not stated" into "zero" on every pass. That mattered
 * because normalizing is not a one-off: a profile is normalized when saved and
 * again when read, so a stored `targetAnnual: null` came back as 0, and
 * `targetAnnual ?? minAnnual` then short-circuited on the 0 and reported no
 * salary at all. Same for `yearsExperience`. Normalizing must be idempotent.
 */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Distinct, order-preserving, compared case/punctuation-insensitively. */
export function distinct(values, max = LIMITS.list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const value = str(raw);
    if (!value) continue;
    const key = normalizeText(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Normalize anything profile-shaped into the canonical structure.
 *
 * Total: every field gets a defined value, so no consumer needs to guard. An
 * unknown key is dropped rather than carried, because a profile is written to
 * disk and read back by a different version of this code.
 *
 * @param {object} input
 * @returns {object} a complete profile
 */
export function normalizeProfile(input = {}) {
  const background = input.background ?? {};
  const intent = input.searchIntent ?? {};
  const comp = intent.compensation ?? {};
  const auth = intent.workAuthorization ?? {};

  return {
    version: PROFILE_VERSION,
    id: slugify(input.id || input.label || 'profile'),
    label: str(input.label) || 'Untitled profile',
    createdAt: str(input.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),

    /**
     * Fingerprint of the master resume this profile's owner has explicitly said
     * does NOT need to change their search.
     *
     * "Keep my current goals" was a no-op that returned a message: the drawer
     * re-ran the comparison on the next render and asked the identical question
     * again, so a deliberate decision had to be re-made every visit and read as
     * the tool not listening. Recording it makes the answer stick until the
     * resume itself changes — at which point asking again is the right
     * behaviour, because the evidence is new.
     */
    acknowledgedResume: str(input.acknowledgedResume, 64),

    identity: {
      fullName: str(input.identity?.fullName),
      preferredName: str(input.identity?.preferredName),
      headline: str(input.identity?.headline),
      links: {
        linkedin: str(input.identity?.links?.linkedin),
        github: str(input.identity?.links?.github),
        portfolio: str(input.identity?.links?.portfolio),
      },
    },
    contact: {
      email: str(input.contact?.email),
      phone: str(input.contact?.phone),
    },
    location: {
      street: str(input.location?.street),
      street2: str(input.location?.street2),
      city: str(input.location?.city),
      state: str(input.location?.state),
      zip: str(input.location?.zip),
      country: str(input.location?.country) || 'United States',
      timezone: str(input.location?.timezone),
    },

    /* ── EVIDENCE: what this person has done ── */
    background: {
      source: str(background.source) || 'manual',
      sourceFile: str(background.sourceFile),
      extractedAt: str(background.extractedAt),
      // Which resume this profile was built from, so building again from the
      // same file updates it instead of saving a copy.
      resumeFingerprint: str(background.resumeFingerprint, 64),
      currentRoles: distinct(background.currentRoles, LIMITS.roles),
      earlierRoles: distinct(background.earlierRoles, LIMITS.roles),
      // Zero is never a STATEMENT of experience, only the residue of a bug:
      // `num()` used to turn null into 0, and a profile saved during that
      // window reads "0 years" forever. Nobody records themselves as having
      // zero years, so treating it as "not stated" both repairs those files on
      // next load and keeps a genuinely unknown value honest.
      yearsExperience: positive(num(background.yearsExperience)),
      seniority: seniorityKey(background.seniority),
      skills: distinct(background.skills, LIMITS.skills),
      industries: distinct(background.industries, LIMITS.industries),
      certifications: distinct(background.certifications, LIMITS.list),
      education: Array.isArray(background.education)
        ? background.education.slice(0, 20).map((e) => ({
          institution: str(e?.institution),
          degree: str(e?.degree),
          field: str(e?.field),
          graduationYear: str(e?.graduationYear),
        }))
        : [],
      workHistory: Array.isArray(background.workHistory)
        ? background.workHistory.slice(0, 30).map((w) => ({
          employer: str(w?.employer),
          title: str(w?.title),
          location: str(w?.location),
          startDate: str(w?.startDate),
          endDate: str(w?.endDate),
          current: bool(w?.current),
          highlights: distinct(w?.highlights, 20),
        }))
        : [],
      leadership: {
        hasManaged: bool(background.leadership?.hasManaged),
        evidence: distinct(background.leadership?.evidence, 20),
      },
    },

    /* ── PREFERENCE: what this person wants next ── */
    searchIntent: {
      targetRoles: distinct(intent.targetRoles, LIMITS.targetRoles),
      // Left empty means "infer my families from my target roles and skills".
      // Setting it is an override, not a requirement.
      roleFamilies: distinct(intent.roleFamilies, 20).map((f) => normalizeText(f).replace(/\s+/g, '-')),
      seniority: seniorityKey(intent.seniority) ?? '',
      locations: distinct(intent.locations, LIMITS.locations),
      workModes: WORK_MODES.filter((m) => (Array.isArray(intent.workModes) ? intent.workModes : WORK_MODES)
        .map((x) => normalizeText(x)).includes(m)),
      employmentTypes: distinct(intent.employmentTypes, 20),
      minContractMonths: num(intent.minContractMonths),
      industries: distinct(intent.industries, LIMITS.industries),
      compensation: {
        display: str(comp.display),
        minAnnual: num(comp.minAnnual),
        targetAnnual: num(comp.targetAnnual),
        currency: str(comp.currency) || 'USD',
      },
      workAuthorization: {
        status: str(auth.status),
        // null = the profile has not said. See `triBool`.
        requiresSponsorship: triBool(auth.requiresSponsorship),
        details: str(auth.details, 600),
      },
      skillsToKeep: distinct(intent.skillsToKeep, LIMITS.skills),
      skillsToGrow: distinct(intent.skillsToGrow, LIMITS.skills),
      excludedLocations: distinct(intent.excludedLocations, LIMITS.locations),
      excludedEmployers: distinct(intent.excludedEmployers, LIMITS.list),
      excludedTerms: distinct(intent.excludedTerms, LIMITS.list),
      relocation: {
        willing: bool(intent.relocation?.willing),
        notes: str(intent.relocation?.notes, 600),
      },
      travel: {
        maxPercent: num(intent.travel?.maxPercent) ?? 0,
        notes: str(intent.travel?.notes, 600),
      },
      startDate: str(intent.startDate),
      // usOnly is a SEARCH preference, not a fact about the person. It used to
      // live in exclusions.json as a fixed `true`, which silently deleted every
      // non-US posting for a candidate who had moved abroad.
      usOnly: bool(intent.usOnly, true),
    },
  };
}

/**
 * Employment-type spellings -> the tokens candidate.schema.json accepts.
 *
 * The profile takes free text ("Full-time", "full_time", "permanent"), and the
 * board's own filter speaks `full_time`; the schema accepts only seven tokens.
 * A profile saying "Full-time" therefore could not be activated at all — the
 * whole profile was refused as "would write an invalid candidate.json".
 */
const EMPLOYMENT_TOKENS = Object.freeze({
  'full time': 'fulltime', fulltime: 'fulltime', permanent: 'fulltime', 'direct hire': 'fulltime',
  'part time': 'parttime', parttime: 'parttime',
  contract: 'contract', contractor: 'contract', freelance: 'contract', temporary: 'contract', temp: 'contract',
  'contract to hire': 'contract-to-hire', c2h: 'contract-to-hire', 'temp to perm': 'contract-to-hire',
  w2: 'W2', c2c: 'c2c', 'corp to corp': 'c2c', 1099: '1099',
});

/** Schema tokens for a list of employment-type spellings; unknown ones are dropped. */
export function canonicalEmploymentTypes(types = []) {
  const out = [];
  for (const raw of Array.isArray(types) ? types : []) {
    const token = EMPLOYMENT_TOKENS[normalizeText(String(raw).replace(/[_-]+/g, ' '))];
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

/** A stable, filename-safe id. */
export function slugify(value) {
  const slug = normalizeText(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'profile';
}

/** Coerce anything to a known seniority key, or null. */
export function seniorityKey(value) {
  const text = normalizeText(value);
  if (!text) return null;
  if (SENIORITY_KEYS.includes(text)) return text;
  const aliases = {
    'entry level': 'entry', junior: 'entry', jr: 'entry', graduate: 'entry', 'new grad': 'entry',
    sr: 'senior', 'mid level': 'mid', intermediate: 'mid', staff: 'lead',
    manager: 'lead', head: 'director', vp: 'executive', 'vice president': 'executive',
    chief: 'executive', 'c level': 'executive',
  };
  return aliases[text] ?? null;
}

/**
 * Every skill term the profile knows, tagged with where it came from.
 *
 * Origin matters downstream: a skill the person wants to GROW into is a valid
 * search signal but is not evidence they already have it, so tailoring must
 * never present it as experience.
 *
 * @param {object} profile
 * @returns {Array<{term: string, origin: 'background'|'keep'|'grow'}>}
 */
export function profileSkills(profile = {}) {
  const out = [];
  const seen = new Set();
  const push = (terms, origin) => {
    for (const term of terms ?? []) {
      const key = normalizeText(term);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ term, origin });
    }
  };
  push(profile.searchIntent?.skillsToKeep, 'keep');
  push(profile.background?.skills, 'background');
  push(profile.searchIntent?.skillsToGrow, 'grow');
  return out;
}

/**
 * Project a profile onto the legacy `config/candidate.json` shape.
 *
 * This is the compatibility seam that makes the whole change tractable: every
 * existing consumer keeps reading candidate.json and needs no edit, while the
 * profile becomes the thing a user actually edits and switches.
 *
 * Note which half feeds what. `targetTitles` and `seniority` come from INTENT
 * (what to search for); `workHistory`, `education`, `certifications` and
 * `domainExperience` come from BACKGROUND (what can be evidenced). Mixing those
 * two is precisely the bug this model exists to prevent.
 *
 * @param {object} profile normalized profile
 * @param {object} [options]
 * @param {string[]} [options.expandedRoles] every role-family variation to
 *   recognize in addition to the stated targets
 * @param {string[]} [options.anchorRoles] the stated roles and their level
 *   variations — decisive matches, and the only ones a board is asked for
 * @param {string[]} [options.adjacentRoles] family siblings — recognized and
 *   scored, but never decisive and never searched
 * @returns {object} a candidate.json-shaped object
 */
export function toCandidateConfig(profile, { expandedRoles = [], anchorRoles, adjacentRoles } = {}) {
  const p = normalizeProfile(profile);
  const intent = p.searchIntent;
  const background = p.background;

  /*
   * `targetTitles` IS THE UNION OF THE TWO TIERS, exactly.
   *
   * It is built from the tiers rather than beside them so the three lists can
   * never disagree. Building it from `expandedRoles` alone dropped the
   * seniority-STRIPPED core of each stated role: someone who asked for "Senior
   * Data Engineer" had "Data Engineer" as an anchor — it is the same job — but
   * not as a target title, so the gate accepted a posting the list did not
   * contain, and any reader comparing the two saw a phantom mismatch.
   */
  const tiered = anchorRoles || adjacentRoles;
  const targetTitles = distinct(
    tiered
      ? [...intent.targetRoles, ...(anchorRoles ?? []), ...(adjacentRoles ?? [])]
      : [...intent.targetRoles, ...expandedRoles],
    LIMITS.targetRoles,
  );

  /*
   * TWO TIERS, NOT ONE LIST. `targetTitles` stays the union so every existing
   * reader keeps working, but the split is published alongside it because the
   * two tiers must not carry equal weight: an anchor is what the candidate
   * asked for and is decisive on its own, while an adjacent title is a way an
   * employer might name the same work and has to clear a higher bar before it
   * reaches the board. Absent both options, everything is an anchor — a
   * hand-written candidate.json behaves exactly as it always did.
   */
  const anchorTitles = distinct(
    anchorRoles ? [...intent.targetRoles, ...anchorRoles] : targetTitles,
    LIMITS.targetRoles,
  );
  const anchorSet = new Set(anchorTitles.map((t) => normalizeText(t)));
  const adjacentTitles = distinct(
    (adjacentRoles ?? []).filter((t) => !anchorSet.has(normalizeText(t))),
    LIMITS.targetRoles,
  );

  return {
    identity: p.identity,
    contact: p.contact,
    location: p.location,
    // `requiresSponsorship` stays TRI-STATE through the projection: null means
    // the profile never said. Collapsing it to a boolean here would reintroduce
    // the guess the profile model exists to prevent, one layer further down —
    // every reader that only needs truthiness is unaffected (null is falsy),
    // and the readers that must not guess test `=== true` / `=== false`.
    workAuthorization: {
      status: intent.workAuthorization.status || 'Unspecified',
      requiresSponsorship: intent.workAuthorization.requiresSponsorship,
      details: intent.workAuthorization.details,
    },
    sponsorshipRequired: intent.workAuthorization.requiresSponsorship,
    targetTitles,
    anchorTitles,
    adjacentTitles,
    seniority: intent.seniority || background.seniority || 'mid',
    employmentPreferences: {
      types: canonicalEmploymentTypes(intent.employmentTypes),
      minContractMonths: intent.minContractMonths ?? 0,
      requiresW2: intent.employmentTypes.some((t) => normalizeText(t) === 'w2'),
    },
    locationPreferences: {
      remote: intent.workModes.includes('remote'),
      onsite: intent.workModes.includes('onsite'),
      hybrid: intent.workModes.includes('hybrid'),
      preferredRegions: intent.locations,
      excludedLocations: intent.excludedLocations,
      excludedTimezones: [],
    },
    // The stack keeps its ORIGIN visible rather than being flattened into one
    // bag: `core` is what they want to keep using, `background` what the resume
    // evidences, `growth` what they are moving toward. Every consumer that
    // flattens `technicalStack` (scoring, discovery) gets the union unchanged.
    technicalStack: {
      core: intent.skillsToKeep,
      background: background.skills.filter(
        (s) => !intent.skillsToKeep.some((k) => normalizeText(k) === normalizeText(s)),
      ),
      growth: intent.skillsToGrow,
    },
    certifications: background.certifications,
    // Carried onto the generated config because the cover-letter writer needs
    // it: that sentence used to interpolate a single number from
    // cover_letter.json, which was one person's and stayed put across a switch.
    yearsExperience: background.yearsExperience,
    domainExperience: distinct([...background.industries, ...intent.industries], LIMITS.industries),
    workHistory: background.workHistory.length ? background.workHistory : [],
    education: background.education,
    salaryPreference: {
      display: intent.compensation.display,
      minAnnualUSD: intent.compensation.minAnnual ?? 0,
      targetAnnualUSD: intent.compensation.targetAnnual ?? 0,
      currency: intent.compensation.currency,
    },
    relocationPreference: intent.relocation,
    travelPreference: intent.travel,
    startDate: intent.startDate,
    prohibited: {
      employers: intent.excludedEmployers,
      terms: intent.excludedTerms,
    },
  };
}

/**
 * Read an existing `config/candidate.json` back into a profile.
 *
 * Used once, to migrate the single hardcoded candidate into the first stored
 * profile without anyone retyping it. The split is applied by FIELD ORIGIN,
 * which is the best available reading of a file that never recorded it:
 * preferences become intent, facts become background.
 *
 * @param {object} candidate parsed candidate.json
 * @param {object} [options]
 * @returns {object} normalized profile
 */
export function fromCandidateConfig(candidate = {}, { id, label } = {}) {
  const stack = candidate.technicalStack ?? {};
  const flatten = (value, out = []) => {
    if (!value) return out;
    if (typeof value === 'string') { if (value.trim()) out.push(value); return out; }
    if (Array.isArray(value)) { for (const v of value) flatten(v, out); return out; }
    if (typeof value === 'object') for (const v of Object.values(value)) flatten(v, out);
    return out;
  };
  // A migrated stack keeps its buckets if it already has them; a legacy flat
  // stack becomes `core`, because those terms were being used for matching and
  // that is what `skillsToKeep` means.
  const core = Array.isArray(stack.core) ? stack.core : flatten(stack);
  const backgroundSkills = Array.isArray(stack.background) ? stack.background : [];
  const growth = Array.isArray(stack.growth) ? stack.growth : [];

  const prefs = candidate.locationPreferences ?? {};
  const modes = [
    prefs.remote !== false ? 'remote' : null,
    prefs.hybrid ? 'hybrid' : null,
    prefs.onsite ? 'onsite' : null,
  ].filter(Boolean);

  return normalizeProfile({
    id: id ?? slugify(candidate.identity?.fullName || 'imported'),
    label: label ?? `${candidate.identity?.preferredName || candidate.identity?.fullName || 'Imported'} — ${candidate.targetTitles?.[0] ?? 'search'}`,
    identity: candidate.identity,
    contact: candidate.contact,
    location: candidate.location,
    background: {
      source: 'migrated',
      currentRoles: candidate.workHistory?.filter((w) => w?.current).map((w) => w.title) ?? [],
      earlierRoles: candidate.workHistory?.filter((w) => !w?.current).map((w) => w.title) ?? [],
      seniority: candidate.seniority,
      skills: backgroundSkills,
      industries: candidate.domainExperience,
      certifications: candidate.certifications,
      education: candidate.education,
      workHistory: candidate.workHistory,
    },
    searchIntent: {
      targetRoles: candidate.targetTitles,
      seniority: candidate.seniority,
      locations: prefs.preferredRegions,
      workModes: modes.length ? modes : ['remote'],
      employmentTypes: candidate.employmentPreferences?.types,
      minContractMonths: candidate.employmentPreferences?.minContractMonths,
      industries: [],
      compensation: {
        display: candidate.salaryPreference?.display,
        minAnnual: candidate.salaryPreference?.minAnnualUSD,
        targetAnnual: candidate.salaryPreference?.targetAnnualUSD,
        currency: candidate.salaryPreference?.currency,
      },
      workAuthorization: candidate.workAuthorization,
      skillsToKeep: core,
      skillsToGrow: growth,
      excludedLocations: prefs.excludedLocations,
      excludedEmployers: candidate.prohibited?.employers,
      excludedTerms: candidate.prohibited?.terms,
      relocation: candidate.relocationPreference,
      travel: candidate.travelPreference,
      startDate: candidate.startDate,
    },
  });
}
