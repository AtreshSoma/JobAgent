/**
 * Can a second person's application ever carry the first person's facts?
 *
 * Switching search profiles changed what was SEARCHED for and nothing about
 * what was SAID on a form. Three independent leaks followed, all measured
 * against the shipped configuration:
 *
 *   1. `config/screening_answers.json` answered "Yes, I will require
 *      sponsorship (H-1B transfer)" and "Authorized to work in the United
 *      States on an H-1B visa" for whoever was applying.
 *   2. `config/cover_letter.json` wrote "10+ years" and named a specific visa.
 *   3. The truthfulness guard was ABSOLUTE rather than profile-relative, so a
 *      US citizen could not state their own status: `validateAnswerEntry`
 *      refused to save "No, I do not require sponsorship", and every
 *      sponsorship question fell through to manual handling.
 *
 * (3) is the one worth dwelling on: the single machine built to stop a false
 * statement reaching an employer was blocking a true one instead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertTruthfulSponsorship, contradictingSponsorshipClaim,
  answerScreeningQuestion, effectiveAnswers,
} from '../../src/apply/screeningQA.js';
import { validateAnswerEntry, upsertScreeningAnswer, readScreeningAnswers } from '../../src/config/profileStore.js';
import { normalizeProfile, toCandidateConfig, fromCandidateConfig } from '../../src/profile/model.js';
import { isPlaceholderValue } from '../../src/config/placeholders.js';
import { loadRoleFamilies } from '../../src/profile/roleFamilies.js';
import { compareToActiveProfile } from '../../src/profile/fromResume.js';
import { deriveScreeningAnswers, deriveFromProfile, applyExclusions, applyScoring } from '../../src/profile/derive.js';
import { saveProfile, activateProfile } from '../../src/profile/store.js';
import { generateCoverLetter } from '../../src/apply/coverLetter.js';
import { resumeProfileMismatch } from '../../src/cli/preflight.js';
import { fixtureCoverLetter } from './helpers/testConfig.js';

const REPO = process.cwd();

/* ─────────────── sponsorship truth is a property of the person ─────────── */

describe('sponsorship truthfulness is judged against the candidate, not a fixed list', () => {
  const NEEDS_NONE = 'No, I do not require sponsorship to work in the United States.';
  const NEEDS_SOME = 'Yes, I will require sponsorship (H-1B transfer).';

  it('lets a candidate who needs no sponsorship say so', () => {
    // Previously impossible: the phrase was on an absolute blocklist.
    expect(assertTruthfulSponsorship([{ answer: NEEDS_NONE }], { requiresSponsorship: false }).truthful).toBe(true);
    expect(validateAnswerEntry(
      { id: 'sponsorship', patterns: ['require sponsorship'], answer: NEEDS_NONE },
      { requiresSponsorship: false },
    ).valid).toBe(true);
  });

  it('still refuses that claim from a candidate who DOES need sponsorship', () => {
    expect(assertTruthfulSponsorship([{ answer: NEEDS_NONE }], { requiresSponsorship: true }).truthful).toBe(false);
  });

  it('refuses the PREVIOUS candidate\'s claim after a switch', () => {
    // The leak, caught in the opposite direction from the original rule.
    expect(assertTruthfulSponsorship([{ answer: NEEDS_SOME }], { requiresSponsorship: false }).truthful).toBe(false);
    expect(contradictingSponsorshipClaim(NEEDS_SOME, false)).toBeTruthy();
  });

  it('keeps the conservative rule when the requirement is unknown', () => {
    // Unknown must never be read as "needs none": that would license exactly
    // the claim the original guard existed to stop.
    expect(assertTruthfulSponsorship([{ answer: NEEDS_NONE }]).truthful).toBe(false);
    expect(assertTruthfulSponsorship([{ answer: NEEDS_SOME }]).truthful).toBe(true);
  });

  it('does not mistake a question or a placeholder for a claim', () => {
    // Both contain "need visa sponsorship" but assert nothing. The shipped
    // placeholder did, and blocked saving an unrelated answer in the same file.
    for (const text of [
      'YOUR truthful sponsorship answer — state whether you need visa sponsorship now or in the future.',
      'Do you require sponsorship?',
    ]) {
      expect(contradictingSponsorshipClaim(text, false), text).toBeNull();
    }
  });

  it('does not flag "Yes" to an inverted question for someone who needs no sponsorship', () => {
    // "Can you work without sponsorship?" -> "Yes" is a misrepresentation only
    // for a candidate who needs sponsorship. For a citizen it is the answer.
    const answers = [{ answer: 'Yes', label: 'Can you work in the US without sponsorship?' }];
    expect(assertTruthfulSponsorship(answers, { requiresSponsorship: false }).truthful).toBe(true);
    expect(assertTruthfulSponsorship(answers, { requiresSponsorship: true }).truthful).toBe(false);
  });

  it('refuses to emit a contradicting stored answer at fill time', () => {
    const stored = {
      defaults: { unknownAction: 'ask_user' },
      answers: [{ id: 'require_sponsorship', patterns: ['require sponsorship'], answer: NEEDS_SOME, type: 'text' }],
    };
    const citizen = { workAuthorization: { requiresSponsorship: false } };
    const result = answerScreeningQuestion(
      'Will you now or in the future require sponsorship?', stored, { candidate: citizen },
    );
    expect(result.answered).toBe(false);
    expect(result.action).toBe('ask_user');
  });
});

/* ─────────────────── personal facts are derived, not shared ─────────────── */

const H1B = normalizeProfile({
  id: 'dana-h1b', label: 'Dana — Senior Data Engineer',
  identity: { fullName: 'Dana Okafor', headline: 'Senior Data Engineer' },
  contact: { email: 'dana@example.com' },
  location: { city: 'Raleigh', state: 'North Carolina', zip: '27601', country: 'United States' },
  background: { currentRoles: ['Senior Data Engineer'], yearsExperience: 9, skills: ['Databricks', 'PySpark'] },
  searchIntent: {
    targetRoles: ['Senior Data Engineer'], seniority: 'senior',
    skillsToKeep: ['Databricks', 'PySpark', 'Python', 'SQL', 'Power BI', 'Azure Data Factory'],
    startDate: 'Two weeks from offer', employmentTypes: ['fulltime'],
    compensation: { minAnnual: 150000, currency: 'USD' },
    workAuthorization: { status: 'H-1B', requiresSponsorship: true },
  },
});

const CITIZEN = normalizeProfile({
  id: 'priya-rn', label: 'Priya — Registered Nurse',
  identity: { fullName: 'Priya Raman', headline: 'Registered Nurse' },
  contact: { email: 'priya@example.com' },
  location: { city: 'Durham', state: 'North Carolina', zip: '27701', country: 'United States' },
  background: { currentRoles: ['Registered Nurse'], yearsExperience: 7, skills: ['ACLS', 'BLS', 'Epic'] },
  searchIntent: {
    targetRoles: ['Registered Nurse'], seniority: 'mid',
    skillsToKeep: ['ACLS', 'BLS', 'Epic', 'Triage', 'IV Therapy', 'Patient Assessment'],
    startDate: 'Immediately', employmentTypes: ['fulltime'],
    compensation: { minAnnual: 85000, currency: 'USD' },
    workAuthorization: { status: 'US Citizen', requiresSponsorship: false },
  },
});

describe('screening answers the profile can state are derived from it', () => {
  it('derives opposite, truthful answers for two different people', () => {
    const byId = (p) => Object.fromEntries(deriveScreeningAnswers(p).map((a) => [a.id, a.answer]));
    const dana = byId(H1B);
    const priya = byId(CITIZEN);

    expect(dana.require_sponsorship).toMatch(/^Yes/);
    expect(priya.require_sponsorship).toMatch(/^No/);
    expect(dana.years_experience).toBe('9+ years');
    expect(priya.years_experience).toBe('7+ years');
    expect(dana.salary_expectation).toMatch(/150,000/);
    expect(priya.salary_expectation).toMatch(/85,000/);
    expect(dana.work_authorization).toMatch(/H-1B/);
    expect(priya.work_authorization).toMatch(/US Citizen/);
  });

  it('every derived answer passes the same truthfulness check a typed one faces', () => {
    for (const profile of [H1B, CITIZEN]) {
      const requiresSponsorship = profile.searchIntent.workAuthorization.requiresSponsorship;
      for (const entry of deriveScreeningAnswers(profile)) {
        expect(validateAnswerEntry(entry, { requiresSponsorship }).valid, `${profile.id}/${entry.id}`).toBe(true);
      }
    }
  });

  it('invents nothing the profile does not state', () => {
    const bare = normalizeProfile({ id: 'bare', searchIntent: { targetRoles: ['Analyst'] } });
    expect(deriveScreeningAnswers(bare)).toEqual([]);
  });

  it('takes precedence over a stored answer with the same id, and leaves the rest alone', () => {
    const doc = {
      answers: [
        { id: 'require_sponsorship', patterns: ['require sponsorship'], answer: 'Yes, H-1B transfer.', type: 'text' },
        { id: 'background_check', patterns: ['background check'], answer: 'Yes.', type: 'text' },
      ],
      derivedAnswers: deriveScreeningAnswers(CITIZEN),
    };
    const effective = effectiveAnswers(doc);
    const sponsorship = effective.filter((a) => a.id === 'require_sponsorship');
    expect(sponsorship).toHaveLength(1);
    expect(sponsorship[0].answer).toMatch(/^No/);
    // A question only the human can answer is untouched.
    expect(effective.find((a) => a.id === 'background_check').answer).toBe('Yes.');
  });
});

/* ───────────────────────── the cover letter follows too ─────────────────── */

describe('the cover letter states the applicant\'s own facts', () => {
  // THE FIXTURE, NOT THE REPO'S OWN config/cover_letter.json.
  //
  // That file is gitignored — it carries a real person's years of experience
  // and work-authorization sentence into documents sent to employers — and on
  // a clean clone it is seeded as a PLACEHOLDER. Reading it here made this
  // suite pass on the author's machine and fail on a fresh checkout, which is
  // precisely the clean-clone failure `fixtureCoverLetter` exists to prevent.
  const template = fixtureCoverLetter;
  const job = { title: 'Registered Nurse', company: 'Mercy Health' };
  const score = { total: 90, matchedKeywords: ['ACLS', 'BLS', 'Epic'] };
  const letterFor = (profile) => generateCoverLetter(
    job, score, { candidate: toCandidateConfig(profile), coverLetter: template, required: true },
  ).text ?? '';

  it('uses each candidate\'s own years of experience, not the template\'s', () => {
    expect(template.yearsOfExperience).toBe('10+ years'); // one person's, shared by all
    expect(letterFor(CITIZEN)).toContain('7+ years');
    expect(letterFor(H1B)).toContain('9+ years');
    expect(letterFor(CITIZEN)).not.toContain('10+ years');
  });

  it('omits the sponsorship sentence for someone who needs no sponsorship', () => {
    expect(letterFor(CITIZEN).toLowerCase()).not.toContain('sponsorship');
  });

  it('never names a visa the candidate does not hold', () => {
    const opt = normalizeProfile({
      ...CITIZEN, id: 'opt', identity: { ...CITIZEN.identity, headline: 'Data Engineer' },
      searchIntent: {
        ...CITIZEN.searchIntent,
        workAuthorization: { status: 'F-1 OPT', requiresSponsorship: true },
      },
    });
    const letter = letterFor(opt);
    expect(letter).toContain('F-1 OPT');
    // The configured sentence names H-1B; using it here would state a status
    // this candidate does not hold, in a document sent to an employer.
    expect(letter).not.toMatch(/H-1B/i);
  });
});

/* ──────────────────────────── normalizing is stable ─────────────────────── */

describe('normalizing a profile is idempotent', () => {
  it('does not turn an absent number into zero on the second pass', () => {
    // `Number(null)` is 0 and finite, so the obvious guard silently rewrote
    // "not stated" as "zero" every time a profile was read back — which then
    // short-circuited `targetAnnual ?? minAnnual` and reported no salary.
    const once = normalizeProfile({
      id: 'x', background: { yearsExperience: 7 },
      searchIntent: { targetRoles: ['RN'], compensation: { minAnnual: 85000, currency: 'USD' } },
    });
    const twice = normalizeProfile(once);
    expect(twice.searchIntent.compensation).toEqual(once.searchIntent.compensation);
    expect(twice.searchIntent.compensation.targetAnnual).toBeNull();
    expect(twice.background.yearsExperience).toBe(7);
    expect(deriveScreeningAnswers(twice).map((a) => a.id)).toContain('salary_expectation');
  });
});

/* ─────────────── switching profiles, end to end, on real files ──────────── */

describe('switching profiles rewrites the personal answers on disk', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jobagent-identity-'));
    mkdirSync(join(root, 'config', 'schemas'), { recursive: true });
    for (const file of ['scoring.json', 'exclusions.json', 'role_families.json']) {
      copyFileSync(join(REPO, 'config', file), join(root, 'config', file));
    }
    copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.json'));
    copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.example.json'));
    for (const schema of ['candidate', 'scoring', 'exclusions']) {
      copyFileSync(
        join(REPO, 'config', 'schemas', `${schema}.schema.json`),
        join(root, 'config', 'schemas', `${schema}.schema.json`),
      );
    }
    // The previous candidate's hand-written answers, as shipped.
    writeFileSync(join(root, 'config', 'screening_answers.json'), `${JSON.stringify({
      defaults: { unknownAction: 'ask_user' },
      answers: [
        { id: 'work_authorization', patterns: ['authorized to work'], answer: 'Authorized to work in the United States on an H-1B visa.', type: 'text' },
        { id: 'years_experience', patterns: ['years of experience'], answer: '10+ years', type: 'text' },
        { id: 'background_check', patterns: ['background check'], answer: 'Yes, willing to complete a standard background check.', type: 'text' },
      ],
    }, null, 2)}\n`);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const read = () => JSON.parse(readFileSync(join(root, 'config', 'screening_answers.json'), 'utf8'));
  const ask = (question, candidate) => answerScreeningQuestion(question, read(), { candidate });

  it('replaces the previous person\'s facts and keeps their generic answers', () => {
    const citizen = { workAuthorization: { requiresSponsorship: false } };
    // Before: the inherited H-1B statement would go onto a nurse's application.
    expect(ask('Are you legally authorized to work in the United States?', citizen).answer)
      .toMatch(/H-1B/);
    expect(ask('How many years of experience do you have?', citizen).answer).toBe('10+ years');

    saveProfile(root, CITIZEN);
    const summary = activateProfile(root, CITIZEN.id);
    expect(summary.written).toContain('config/screening_answers.json');

    // After: her own facts.
    expect(ask('Are you legally authorized to work in the United States?', citizen).answer)
      .toMatch(/US Citizen/);
    expect(ask('Will you now or in the future require sponsorship?', citizen).answer).toMatch(/^No/);
    expect(ask('How many years of experience do you have?', citizen).answer).toBe('7+ years');
    // A question the profile cannot answer is still hers to have answered.
    expect(ask('Do you consent to a background check?', citizen).answer).toMatch(/^Yes/);
    // And the file she inherited is unedited.
    expect(read().answers.map((a) => a.id)).toEqual(['work_authorization', 'years_experience', 'background_check']);
  });

  it('a later hand-written save does not wipe the derived answers', () => {
    // `writeScreeningAnswers` rebuilds the document from scratch, so without
    // carrying the generated entries through, saving one unrelated answer would
    // silently delete every derived one and put the inherited facts back in play.
    saveProfile(root, CITIZEN);
    activateProfile(root, CITIZEN.id);
    const before = read().derivedAnswers.map((a) => a.id);
    expect(before.length).toBeGreaterThan(0);

    upsertScreeningAnswer(root, {
      id: 'commute', patterns: ['willing to commute'], answer: 'Yes, up to 30 miles.', type: 'text',
    });

    const after = read();
    expect(after.derivedAnswers.map((a) => a.id)).toEqual(before);
    expect(after.answers.map((a) => a.id)).toContain('commute');
    // And the derived answer still wins at fill time.
    const citizen = { workAuthorization: { requiresSponsorship: false } };
    expect(ask('How many years of experience do you have?', citizen).answer).toBe('7+ years');
    expect(readScreeningAnswers(root).derivedAnswers.length).toBe(before.length);
  });
});

/* ─────────── defects that only showed up when the UI was actually run ────── */

describe('regressions found by driving the real UI', () => {
  it('never derives an answer out of template instruction text', () => {
    // The dashboard rendered `work_authorization — "Describe your authorization
    // truthfully — this is used verbatim in screening answers."` — an
    // instruction to the USER, queued to be typed onto an employer's form.
    const fromTemplate = fromCandidateConfig(
      JSON.parse(readFileSync(join(REPO, 'config', 'candidate.example.json'), 'utf8')),
    );
    const derived = deriveScreeningAnswers(fromTemplate);
    const ids = derived.map((a) => a.id);
    expect(ids).not.toContain('work_authorization');
    // And nothing at all may be derived from a status that is still the
    // template's "US Citizen | Green Card | H-1B | OPT | ..." menu, because
    // `requiresSponsorship` then carries a default rather than a statement.
    expect(ids).not.toContain('require_sponsorship');
    for (const entry of derived) {
      expect(isPlaceholderValue(entry.answer), entry.id).toBe(false);
    }
  });

  it('reports a skill overlap that is actually a fraction', () => {
    // The panel read "94 of 47 profile skills appear in this resume": the two
    // profile skill buckets overlap by design, and the numerator counted the
    // raw concatenation against a de-duplicated denominator.
    const background = { skills: ['Python', 'SQL'], currentRoles: ['Data Engineer'] };
    const profile = normalizeProfile({
      id: 'dup', identity: { fullName: 'Same Person' },
      background: { skills: ['Python', 'SQL', 'Databricks'] },
      searchIntent: { targetRoles: ['Data Engineer'], skillsToKeep: ['Python', 'SQL', 'Databricks', 'Power BI'] },
    });
    const verdict = compareToActiveProfile(background, profile, loadRoleFamilies(REPO));
    expect(verdict.skillOverlap).toBeGreaterThanOrEqual(0);
    expect(verdict.skillOverlap).toBeLessThanOrEqual(1);
    const [shared, total] = (verdict.reasons.join(' ').match(/(\d+) of (\d+) profile skills/) ?? []).slice(1).map(Number);
    expect(shared).toBeLessThanOrEqual(total);
  });

  it('hands the browser extension the SAME answers the CLI filler would use', () => {
    // The extension is a second fill path and read `screeningAnswers.answers`
    // directly, bypassing the profile-derived ones entirely — so after a switch
    // it would have typed the previous candidate's facts into the browser while
    // the CLI used the right ones.
    const doc = {
      defaults: { unknownAction: 'ask_user' },
      answers: [{ id: 'require_sponsorship', patterns: ['require sponsorship'], answer: 'Yes, H-1B transfer.', type: 'text' }],
      derivedAnswers: deriveScreeningAnswers(CITIZEN),
    };
    const viaExtension = effectiveAnswers(doc).find((a) => a.id === 'require_sponsorship');
    expect(viaExtension.answer).toMatch(/^No/);
  });
});

/* ──────────── personal data must not reach a file git tracks ────────────── */

describe('activation keeps personal data out of tracked config', () => {
  it('never stamps a profile id onto a TRACKED config file', () => {
    // A profile id is slugified from the person's own NAME, and
    // config/profiles/ is gitignored precisely because it is personal.
    // `applyExclusions` stamped `_generatedFrom: config/profiles/<name>.json`
    // onto config/exclusions.json — which IS tracked — so activating a profile
    // wrote the user's name into git history. Caught by grepping the staged
    // diff for personal identifiers before pushing.
    const derived = deriveFromProfile(CITIZEN);
    const exclusions = applyExclusions({}, derived);
    const scoring = applyScoring({}, derived);

    for (const [name, doc] of [['exclusions', exclusions], ['scoring', scoring]]) {
      const text = JSON.stringify(doc);
      expect(text, `${name}.json must not name the profile`).not.toContain(CITIZEN.id);
      expect(text, `${name}.json must not carry the person's name`)
        .not.toMatch(/priya|raman/i);
    }
    // It still says the section is generated — just not by whom.
    expect(exclusions._generatedFrom).toBeTruthy();
    expect(exclusions._generatedFrom).not.toContain(CITIZEN.id);
  });

  it('still records the source profile in the GITIGNORED candidate config', () => {
    // Doctor reads this to detect drift between the profile and its generated
    // view, so the pointer has to survive where it is safe to keep it.
    const derived = deriveFromProfile(CITIZEN);
    expect(derived.candidate._generatedFrom).toContain(CITIZEN.id);
  });

  it('the repo ignores every file that carries profile data', () => {
    const ignore = readFileSync(join(REPO, '.gitignore'), 'utf8');
    for (const path of ['config/profiles/', 'config/candidate.json', 'config/screening_answers.json']) {
      expect(ignore, `${path} must be gitignored`).toContain(path);
    }
  });
});

/* ───────────────────── the resume must belong to the profile ────────────── */

describe('preflight refuses to tailor one person\'s resume under another\'s profile', () => {
  it('passes when no profile is active', () => {
    expect(resumeProfileMismatch({ root: REPO, profile: null }, 'whatever.docx')).toEqual([]);
  });

  it('never turns an unreadable resume into an accusation about whose it is', () => {
    // A corrupt master is reported by its own check; this one must stay silent.
    const problems = resumeProfileMismatch(
      { root: REPO, profile: CITIZEN }, join(REPO, 'config', 'scoring.json'),
    );
    expect(problems).toEqual([]);
  });
});
