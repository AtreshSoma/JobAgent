/**
 * Regressions for the 2026-09-18 audit.
 *
 * Each block below reproduces one defect the audit measured, then asserts the
 * behaviour that replaced it. They are grouped in the audit's own order —
 * critical first — and named after what the user would have experienced, not
 * after the function that changed.
 *
 * The audit's closing observation is the reason this file exists at all: every
 * one of these defects passed a green suite of 1,568 tests. What that suite did
 * not cover was TRANSITIONS — switching candidate, a fact the profile does not
 * state, preparing the same role twice, a submission that fails. So these tests
 * are written as transitions wherever the defect was one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runPipeline, preparePacket } from '../../src/pipeline/index.js';
import { openDatabase } from '../../src/logging/db.js';
import { JobLogger, createPinoLogger } from '../../src/logging/jobLogger.js';
import { loadTestConfig, fixtureCoverLetter } from './helpers/testConfig.js';
import { normalizeJob } from '../../src/search/normalize.js';
import * as F from './fixtures/jobs.js';

import { buildJobPaths, jobDiscriminator } from '../../src/utils/outputPaths.js';
import { packetOwner, packetOwnershipCheck, buildApplicationPacket } from '../../src/apply/applicationPacket.js';
import { normalizeProfile, toCandidateConfig, fromCandidateConfig } from '../../src/profile/model.js';
import { deriveScreeningAnswers, applyScreeningAnswers, applyScoring, deriveFromProfile } from '../../src/profile/derive.js';
import { effectiveAnswers, answerScreeningQuestion } from '../../src/apply/screeningQA.js';
import { submissionFailureSignal, visibleText } from '../../src/automation/applyRunner.js';
import { yearsOfExperience, profileFromResume, buildBackground, compareToActiveProfile } from '../../src/profile/fromResume.js';
import { loadRoleFamilies } from '../../src/profile/roleFamilies.js';
import { isBlockingResumeMismatch } from '../../src/profile/resumeIdentity.js';
import { generateCoverLetter } from '../../src/apply/coverLetter.js';
import { scoreJob, candidateStackTerms } from '../../src/scoring/scorer.js';
import { applyExclusions } from '../../src/scoring/exclusionFilter.js';
import { explainScore } from '../../src/scoring/explainScore.js';
import { checkSearchConstraints, parseAnnualSalary, parseContractMonths } from '../../src/scoring/searchConstraints.js';
import { scoringFingerprint } from '../../src/scoring/fingerprint.js';
import { saveProfile, activateProfile } from '../../src/profile/store.js';
import { writeProfile } from '../../src/config/profileStore.js';
import { boardPage } from '../../src/dashboard/data.js';

const base = loadTestConfig({ loadEnv: false, env: {} });
const REPO = process.cwd();

/** Deterministic offline stand-in for the Python tailor: writes a real file. */
async function tailorFn({ job, options = {} }) {
  mkdirSync(options.outputDir, { recursive: true });
  const path = join(options.outputDir, options.outputFilename ?? 'tailored.docx');
  writeFileSync(path, `tailored resume for ${job.company} ${job.title}`, 'utf8');
  return {
    tailored: true, output_path: path, pdf_path: null, emphasized: 3,
    validation: { ok: true, issues: [] }, warning: null, usedFallback: false,
  };
}

/* ══════════════════ 1. packets can no longer overwrite each other ══════════ */

describe('two different jobs never share one application packet', () => {
  let root; let db; let logger; let config;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'audit-collide-'));
    db = openDatabase({ path: ':memory:' });
    const { logger: pino } = createPinoLogger({ toFile: false });
    logger = new JobLogger({ db, logger: pino });
    config = { ...base, root };
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it('gives same-company, same-title, same-day requisitions their own folder', async () => {
    // The measured defect: the folder was {Company}/{Title}_{Date}, so preparing
    // a second requisition overwrote the first one's resume, cover letter and
    // packet — and the FIRST job's approval then pointed at documents
    // describing the SECOND job.
    const shared = {
      company: 'Northwind Bank', title: 'Senior Data Engineer',
      postedAt: F.azureFabricSenior.postedAt, source: 'greenhouse',
      jdText: F.azureFabricSenior.jdText,
    };
    const jobA = normalizeJob({ ...shared, sourceJobId: 'REQ-111', url: 'https://boards.greenhouse.io/nw/jobs/111' });
    const jobB = normalizeJob({ ...shared, sourceJobId: 'REQ-222', url: 'https://boards.greenhouse.io/nw/jobs/222' });
    expect(jobA.id).not.toBe(jobB.id);

    const counters = { jobs_prepared: 0 };
    const deps = { tailorFn, now: F.NOW, skipResumeIdentityCheck: true };
    const score = { total: 90, matchedKeywords: [], missingKeywords: [], breakdown: {} };
    const pathA = await preparePacket({ config, db, logger, job: jobA, score, tier: 'Apply', deps, counters });
    const pathB = await preparePacket({ config, db, logger, job: jobB, score, tier: 'Apply', deps, counters });

    expect(pathA).not.toBe(pathB);
    // Both still exist — neither was overwritten...
    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);
    // ...and each describes its OWN job, which is the property the approval
    // boundary depends on.
    expect(JSON.parse(readFileSync(pathA, 'utf8')).job.id).toBe(jobA.id);
    expect(JSON.parse(readFileSync(pathB, 'utf8')).job.id).toBe(jobB.id);
  });

  it('keeps one job on ONE folder when it is prepared twice', () => {
    // The discriminator has to be deterministic, or re-preparing a job would
    // litter a new folder every time instead of replacing its documents.
    const args = {
      root: '/r', company: 'Acme', title: 'Analyst', dateOrId: '20260918', jobId: 'job-abc',
    };
    expect(buildJobPaths(args).folder).toBe(buildJobPaths(args).folder);
    expect(jobDiscriminator('job-abc')).toBe(jobDiscriminator('job-abc'));
    expect(jobDiscriminator('job-abc')).not.toBe(jobDiscriminator('job-abd'));
    // Legacy callers that pass no job id keep the old name, so existing folders
    // on disk still resolve.
    expect(buildJobPaths({ ...args, jobId: '' }).jobFolder).toBe('Analyst_2026-09-18');
  });
});

/* ══════════════════ 2. a packet belongs to one candidate ═══════════════════ */

describe('a packet prepared for one candidate is never filled for another', () => {
  const ownerConfig = (name, email, profileId) => ({
    candidate: { identity: { fullName: name }, contact: { email } },
    profile: { id: profileId, label: profileId },
  });

  it('records who a packet was built for', () => {
    const owner = packetOwner(ownerConfig('Dana Okafor', 'dana@example.com', 'dana-data'));
    expect(owner).toMatchObject({
      candidateName: 'Dana Okafor', candidateEmail: 'dana@example.com', profileId: 'dana-data',
    });
  });

  it('refuses a packet belonging to a different person', () => {
    const packet = { owner: packetOwner(ownerConfig('Dana Okafor', 'dana@example.com', 'dana-data')) };
    const check = packetOwnershipCheck(packet, ownerConfig('Priya Raman', 'priya@example.com', 'priya-rn'));
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/Dana Okafor/);
  });

  it('refuses a packet built under a DIFFERENT SEARCH PROFILE for the same person', () => {
    // Two profiles can describe one person searching two directions, with
    // different target roles, screening answers and tailored resumes. Identity
    // alone would wave that through.
    const packet = { owner: packetOwner(ownerConfig('Dana Okafor', 'dana@example.com', 'dana-data')) };
    const check = packetOwnershipCheck(packet, ownerConfig('Dana Okafor', 'dana@example.com', 'dana-nursing'));
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/search profile/i);
  });

  it('accepts the packet it was built for', () => {
    const config = ownerConfig('Dana Okafor', 'dana@example.com', 'dana-data');
    expect(packetOwnershipCheck({ owner: packetOwner(config) }, config).ok).toBe(true);
  });

  it('keeps a legacy packet only when its documents are named for this candidate', () => {
    // A legacy packet has no owner. It used to pass unconditionally (the
    // fallback read a field no packet was ever written with), so legacy
    // "Jane Doe" packets were filled for whoever was active. It is now kept
    // only when its documents carry the active candidate's file prefix.
    const config = ownerConfig('Dana Okafor', 'dana@example.com', 'dana-data');
    expect(packetOwnershipCheck({}, config).ok).toBe(false);
    expect(packetOwnershipCheck({ resumePath: '/out/Jane_Doe_Resume_Analyst.docx' }, config).ok).toBe(false);
    expect(packetOwnershipCheck({ resumePath: '/out/Dana_Okafor_Resume_Analyst.docx' }, config).ok).toBe(true);
    // ...and a legacy packet that names someone else is still caught.
    expect(packetOwnershipCheck({ candidateName: 'Priya Raman' }, config).ok).toBe(false);
  });

  it('stamps the owner onto every packet it builds', () => {
    const packet = buildApplicationPacket({
      job: { id: 'j1', company: 'Acme', title: 'Analyst', url: 'https://x', source: 'greenhouse' },
      score: { total: 80 }, tier: 'Apply',
      candidate: base.candidate, screeningAnswers: base.screeningAnswers,
      owner: packetOwner({ ...base, profile: { id: 'p1', label: 'P1' } }),
      coverLetter: { generated: false },
    });
    expect(packet.owner.profileId).toBe('p1');
    expect(packet.owner.candidateName).toBe(base.candidate.identity.fullName);
  });
});

/* ══════════════════ 3. no invented or borrowed personal facts ══════════════ */

describe('a profile never answers a question it cannot answer', () => {
  it('says nothing about sponsorship when the profile has not stated it', () => {
    // Measured: supplying a status and omitting the boolean produced
    // "No, I do not require visa sponsorship."
    const unstated = normalizeProfile({
      id: 'x', searchIntent: { targetRoles: ['Nurse'], workAuthorization: { status: 'US Citizen' } },
    });
    expect(unstated.searchIntent.workAuthorization.requiresSponsorship).toBe(null);
    const ids = deriveScreeningAnswers(unstated).map((a) => a.id);
    expect(ids).not.toContain('require_sponsorship');
    // The work-authorization answer still states the status it DOES know, with
    // no claim about sponsorship in either direction.
    const auth = deriveScreeningAnswers(unstated).find((a) => a.id === 'work_authorization');
    expect(auth.answer).toBe('US Citizen');
    expect(auth.answer.toLowerCase()).not.toContain('sponsorship');
  });

  it('still answers plainly when the profile HAS stated it', () => {
    const stated = normalizeProfile({
      id: 'y',
      searchIntent: {
        targetRoles: ['Nurse'],
        workAuthorization: { status: 'US Citizen', requiresSponsorship: false },
      },
    });
    const answer = deriveScreeningAnswers(stated).find((a) => a.id === 'require_sponsorship');
    expect(answer.answer).toMatch(/^No/);
  });

  it('withholds the PREVIOUS person\'s answer when this profile states nothing', () => {
    // The measured leak: a profile with no stated experience and no stated
    // salary answered "12+ years" and "180,000 USD", both inherited.
    const silent = normalizeProfile({ id: 'silent', searchIntent: { targetRoles: ['Analyst'] } });
    const doc = applyScreeningAnswers({
      answers: [
        { id: 'years_experience', patterns: ['years of experience'], answer: '12+ years', type: 'text' },
        { id: 'salary_expectation', patterns: ['salary expectation'], answer: '180,000 USD', type: 'text' },
        { id: 'background_check', patterns: ['background check'], answer: 'Yes.', type: 'text' },
      ],
    }, { screeningAnswers: deriveScreeningAnswers(silent), profile: silent });

    const effective = effectiveAnswers(doc);
    expect(effective.find((a) => a.id === 'years_experience')).toBeUndefined();
    expect(effective.find((a) => a.id === 'salary_expectation')).toBeUndefined();
    // A question only the human can answer is untouched.
    expect(effective.find((a) => a.id === 'background_check').answer).toBe('Yes.');

    // End to end: the form filler asks the human instead of typing a stranger's
    // number onto the application.
    const asked = answerScreeningQuestion('How many years of experience do you have?', {
      screeningAnswers: doc, candidate: toCandidateConfig(silent),
    });
    expect(asked.answered).toBe(false);
    expect(asked.action).toBe('ask_user');
  });

  it('keeps an answer the user wrote THEMSELVES under the active profile', () => {
    // The shadowing rule must close the leak without making a hand-written
    // answer useless. An answer saved under the profile that is active now is
    // still this candidate's own statement about themselves.
    const active = normalizeProfile({ id: 'mine', searchIntent: { targetRoles: ['Analyst'] } });
    const doc = applyScreeningAnswers({
      answers: [
        { id: 'years_experience', patterns: ['years of experience'], answer: '8+ years', type: 'text', profileId: 'mine' },
        { id: 'salary_expectation', patterns: ['salary expectation'], answer: '180,000 USD', type: 'text', profileId: 'someone-else' },
      ],
    }, { screeningAnswers: deriveScreeningAnswers(active), profile: active });

    const effective = effectiveAnswers(doc);
    expect(effective.find((a) => a.id === 'years_experience')?.answer).toBe('8+ years');
    // ...while one stamped with a DIFFERENT profile is still withheld.
    expect(effective.find((a) => a.id === 'salary_expectation')).toBeUndefined();
  });

  it('does not carry one person\'s facts into a profile built from another\'s resume', () => {
    const dana = normalizeProfile({
      id: 'dana', identity: { fullName: 'Dana Okafor' },
      searchIntent: {
        targetRoles: ['Senior Data Engineer'],
        workAuthorization: { status: 'H-1B', requiresSponsorship: true },
        compensation: { minAnnual: 150000, currency: 'USD' },
        startDate: '2026-01-05',
        locations: ['Remote'],
      },
    });
    const priyaResume = [
      'Priya Raman', 'Registered Nurse', 'priya@example.com',
      'Experience', 'Registered Nurse | Mercy General', 'Raleigh, NC | 2019 - Present',
      'Skills', 'Clinical: ACLS, BLS, Epic',
    ];
    const built = profileFromResume(priyaResume, { currentProfile: dana });
    expect(built.searchIntent.workAuthorization.status).toBe('');
    expect(built.searchIntent.workAuthorization.requiresSponsorship).toBe(null);
    expect(built.searchIntent.compensation.minAnnual).toBe(null);
    expect(built.searchIntent.startDate).toBe('');
    // Contact comes from Priya's OWN resume header — never from Dana's profile.
    expect(built.contact.email).toBe('priya@example.com');
    // A SEARCH preference is not a personal fact, so it still carries over.
    expect(built.searchIntent.locations).toEqual(['Remote']);
  });
});

/* ══════════════════ 4. a failed submission is not a submission ═════════════ */

describe('a failed submission is never recorded as submitted', () => {
  it('reads an HTTP 500 redirect as failure, not success', () => {
    // Measured with a mock: a redirect to a 500 page returned
    // status "submitted", submitted: true, on the evidence
    // "page navigated, form gone".
    const errorPage = '<html><head><title>500 - Internal Server Error</title></head>'
      + '<body><h1>Something went wrong</h1><p>Please try again later.</p></body></html>';
    expect(submissionFailureSignal({ html: errorPage })).toMatch(/error page/i);
    expect(submissionFailureSignal({ status: 500, html: '<html><body>ok</body></html>' }))
      .toMatch(/500/);
  });

  it('does not mistake an ATS confirmation for an error', () => {
    const good = '<html><head><title>Application received</title></head>'
      + '<body><h1>Thank you for applying</h1></body></html>';
    expect(submissionFailureSignal({ html: good })).toBe(null);
    expect(submissionFailureSignal({ status: 200, html: good })).toBe(null);
  });

  it('judges the page a human SEES, not the scripts it ships', () => {
    // Every large ATS carries both phrases inside its JavaScript bundle as
    // templates for states the applicant has not reached.
    const bundled = '<html><body><div id="root"></div>'
      + '<script>var T={ok:"Thank you for applying",err:"Something went wrong"}</script>'
      + '</body></html>';
    expect(visibleText(bundled)).not.toMatch(/thank you for applying/i);
    expect(submissionFailureSignal({ html: bundled })).toBe(null);
  });
});

/* ══════════════════ 5. wanting a skill is not having it ════════════════════ */

describe('skills the candidate wants to LEARN are not presented as strengths', () => {
  const growthOnly = {
    identity: { fullName: 'Sam Lee', headline: 'Analyst' },
    targetTitles: ['Data Engineer'],
    technicalStack: { core: [], background: [], growth: ['Kubernetes', 'Terraform', 'Go', 'Kafka', 'Spark', 'Rust'] },
    domainExperience: [],
    workAuthorization: { status: 'US Citizen', requiresSponsorship: false },
  };
  const jd = normalizeJob({
    source: 'greenhouse', company: 'Acme', title: 'Data Engineer', sourceJobId: 'g1',
    postedAt: F.azureFabricSenior.postedAt,
    jdText: 'You will use Kubernetes, Terraform, Go, Kafka, Spark and Rust every day.',
  });

  it('earns no core-skill points from growth-only skills', () => {
    // Measured: six growth-only skills earned 30/30 core-skill points.
    const result = scoreJob(jd, {
      scoring: base.scoring, sponsorship: { status: 'Unconfirmed' }, candidate: growthOnly, now: F.NOW,
    });
    expect(result.breakdown.coreSkills.points).toBe(0);
    // No GROWTH term is reported as matched. (The target TITLE still matches —
    // that is what titleFit is for, and it is not a claim about a skill.)
    for (const wanted of growthOnly.technicalStack.growth) {
      expect(result.matchedKeywords, wanted).not.toContain(wanted);
    }
  });

  it('reports them as GAPS rather than as met requirements', () => {
    const result = scoreJob(jd, {
      scoring: { ...base.scoring, marketSkills: ['kubernetes', 'terraform', 'kafka'] },
      sponsorship: { status: 'Unconfirmed' }, candidate: growthOnly, now: F.NOW,
    });
    expect(result.missingKeywords.length).toBeGreaterThan(0);
  });

  it('keeps them out of the cover letter\'s "core strengths"', () => {
    const letter = generateCoverLetter(
      { title: 'Data Engineer', company: 'Acme' },
      { total: 90, matchedKeywords: [] },
      { candidate: { ...growthOnly, yearsExperience: 6 }, coverLetter: fixtureCoverLetter, required: true },
    );
    for (const claimed of growthOnly.technicalStack.growth) {
      expect(letter.text).not.toContain(claimed);
    }
  });

  it('still lets a growth skill HELP FIND a job — discovery is not a claim', () => {
    expect(candidateStackTerms(growthOnly)).toEqual([]);
    expect(candidateStackTerms(growthOnly, { includeGrowth: true })).toContain('Kubernetes');
  });

  it('does not drop a legacy flat stack that names its buckets freely', () => {
    const legacy = { technicalStack: { cloud: ['AWS'], languages: ['Python'] } };
    expect(candidateStackTerms(legacy).sort()).toEqual(['AWS', 'Python']);
  });
});

/* ══════════════════ 6. experience is time worked, not time elapsed ═════════ */

describe('experience is never overstated', () => {
  const sections = (lines) => [{ kind: 'experience', lines }];

  it('does not count a career gap as experience', () => {
    // Measured: 2010–2011 and 2024–2026 produced 16 years.
    const lines = ['Analyst | FirstCo', '2010 - 2011', 'Engineer | SecondCo', '2024 - 2026'];
    expect(yearsOfExperience(lines.join('\n'), sections(lines), new Date('2026-09-18')))
      .toBe(3);
  });

  it('still adds up continuous employment', () => {
    const lines = ['Engineer | A', '2018 - 2021', 'Senior Engineer | B', '2021 - 2026'];
    expect(yearsOfExperience(lines.join('\n'), sections(lines), new Date('2026-09-18')))
      .toBe(8);
  });

  it('trusts a stated total over arithmetic', () => {
    const lines = ['Nurse | Mercy', '2019 - Present'];
    const text = `Registered Nurse with 12 years of experience.\n${lines.join('\n')}`;
    expect(yearsOfExperience(text, sections(lines), new Date('2026-09-18'))).toBe(12);
  });

  it('omits the experience sentence rather than borrowing the template\'s number', () => {
    // The fallback chain was `cover_letter.json`'s yearsOfExperience — one
    // person's number in a shared file — then the literal "several years".
    expect(fixtureCoverLetter.yearsOfExperience).toBe('10+ years');
    const noYears = {
      identity: { fullName: 'Sam Lee', headline: 'Analyst' },
      targetTitles: ['Analyst'],
      technicalStack: { core: ['Excel'] },
      workAuthorization: { status: 'US Citizen', requiresSponsorship: false },
    };
    const letter = generateCoverLetter(
      { title: 'Analyst', company: 'Acme' }, { total: 90, matchedKeywords: ['Excel'] },
      { candidate: noYears, coverLetter: fixtureCoverLetter, required: true },
    );
    expect(letter.text).not.toContain('10+ years');
    expect(letter.text).not.toContain('several years');
    expect(letter.text).not.toMatch(/with\s+of experience/);
    // It is still a letter about the right job.
    expect(letter.text).toContain('Acme');
  });

  it('uses the candidate\'s own number when they have one', () => {
    const withYears = {
      identity: { fullName: 'Sam Lee', headline: 'Analyst' },
      targetTitles: ['Analyst'], technicalStack: { core: ['Excel'] }, yearsExperience: 7,
      workAuthorization: { status: 'US Citizen', requiresSponsorship: false },
    };
    const letter = generateCoverLetter(
      { title: 'Analyst', company: 'Acme' }, { total: 90, matchedKeywords: ['Excel'] },
      { candidate: withYears, coverLetter: fixtureCoverLetter, required: true },
    );
    expect(letter.text).toContain('7+ years');
  });
});

/* ══════════════════ 7. sponsorship is a property of the person ═════════════ */

describe('a candidate who needs no sponsorship keeps the jobs that say so', () => {
  const deniesSponsorship = normalizeJob({
    source: 'greenhouse', company: 'Acme', title: 'Senior Data Engineer', sourceJobId: 'ns-1',
    postedAt: F.azureFabricSenior.postedAt,
    jdText: `${F.azureFabricSenior.jdText} We are unable to sponsor work visas for this role.`,
  });
  const citizen = { ...base.candidate, workAuthorization: { status: 'US Citizen', requiresSponsorship: false }, sponsorshipRequired: false };
  const visaHolder = { ...base.candidate, workAuthorization: { status: 'H-1B', requiresSponsorship: true }, sponsorshipRequired: true };
  const unstated = { ...base.candidate, workAuthorization: { status: 'US Citizen', requiresSponsorship: null }, sponsorshipRequired: null };

  it('does not discard it for someone who has stated they need none', () => {
    expect(applyExclusions(deniesSponsorship, base.exclusions, { now: F.NOW, candidate: citizen }).excluded).toBe(false);
  });

  it('still discards it for someone who needs sponsorship', () => {
    const r = applyExclusions(deniesSponsorship, base.exclusions, { now: F.NOW, candidate: visaHolder });
    expect(r.excluded).toBe(true);
    expect(r.category).toBe('sponsorship_denial');
  });

  it('still discards it when nobody has said — silence is not a "no"', () => {
    expect(applyExclusions(deniesSponsorship, base.exclusions, { now: F.NOW, candidate: unstated }).excluded).toBe(true);
    // And with no candidate supplied at all, the historical behaviour stands.
    expect(applyExclusions(deniesSponsorship, base.exclusions, { now: F.NOW }).excluded).toBe(true);
  });

  it('does not hold a strong match in Queue for a candidate who needs no visa', () => {
    const strong = { total: 88, sponsorship: 'Unconfirmed', breakdown: {}, matchedKeywords: [], missingKeywords: [] };
    expect(explainScore(strong, base.scoring, { candidate: citizen }).tier).not.toBe('Queue');
    expect(explainScore(strong, base.scoring, { candidate: visaHolder }).sponsorshipGated).toBe(true);
  });

  it('does not spend sponsorship points on a candidate the question does not apply to', () => {
    const forCitizen = scoreJob(F.azureFabricSenior, {
      scoring: base.scoring, sponsorship: { status: 'Unconfirmed' }, candidate: citizen, now: F.NOW,
    });
    expect(forCitizen.breakdown.sponsorshipFeasibility.points)
      .toBe(base.scoring.weights.sponsorshipFeasibility);
  });
});

/* ══════════════════ 8. saving application details actually saves ══════════ */

describe('an edit made in the profile editor survives reactivation', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'audit-editor-'));
    mkdirSync(join(root, 'config', 'schemas'), { recursive: true });
    for (const f of ['candidate.schema.json', 'scoring.schema.json', 'exclusions.schema.json']) {
      copyFileSync(join(REPO, 'config', 'schemas', f), join(root, 'config', 'schemas', f));
    }
    copyFileSync(join(REPO, 'config', 'role_families.json'), join(root, 'config', 'role_families.json'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes through to the search profile, not only to the generated view', () => {
    // Measured: saving a changed email and reactivating the profile brought the
    // old email back, because activation regenerates candidate.json from
    // config/profiles/<id>.json.
    const profile = fromCandidateConfig(base.candidate, { id: 'probe', label: 'Probe' });
    saveProfile(root, profile);
    activateProfile(root, 'probe');

    writeProfile(root, { 'contact.email': 'changed@example.com' });
    const afterSave = JSON.parse(readFileSync(join(root, 'config', 'candidate.json'), 'utf8'));
    expect(afterSave.contact.email).toBe('changed@example.com');

    activateProfile(root, 'probe');
    const afterReactivate = JSON.parse(readFileSync(join(root, 'config', 'candidate.json'), 'utf8'));
    expect(afterReactivate.contact.email).toBe('changed@example.com');
  });

  it('still works with no profile active — candidate.json is then the source', () => {
    writeFileSync(join(root, 'config', 'candidate.json'), JSON.stringify(base.candidate, null, 2));
    const result = writeProfile(root, { 'contact.phone': '555-0000' });
    expect(result.profile).toBe(null);
    expect(JSON.parse(readFileSync(join(root, 'config', 'candidate.json'), 'utf8')).contact.phone)
      .toBe('555-0000');
  });
});

/* ══════════════════ 10. a stale score is not a current score ═══════════════ */

describe('switching candidate invalidates the scores judged for the last one', () => {
  it('changes the fingerprint when the CANDIDATE changes', () => {
    const a = scoringFingerprint(base);
    const b = scoringFingerprint({ ...base, candidate: { ...base.candidate, targetTitles: ['Registered Nurse'] } });
    expect(a).not.toBe(b);
  });

  it('changes the fingerprint when the SCORING CONFIG changes', () => {
    const a = scoringFingerprint(base);
    const b = scoringFingerprint({ ...base, scoring: { ...base.scoring, tiers: { ...base.scoring.tiers, apply: 60 } } });
    expect(a).not.toBe(b);
  });

  it('is stable across key order and repeated calls', () => {
    expect(scoringFingerprint(base)).toBe(scoringFingerprint(base));
    const reordered = { ...base, candidate: { ...base.candidate } };
    expect(scoringFingerprint(reordered)).toBe(scoringFingerprint(base));
  });

  it('re-scores an unchanged posting after the profile changes', async () => {
    // Measured: after switching a test candidate from engineering to nursing, a
    // previously scored engineering job stayed at 94/100 and ZERO jobs rescored.
    const root = mkdtempSync(join(tmpdir(), 'audit-stale-'));
    const db = openDatabase({ path: ':memory:' });
    const { logger: pino } = createPinoLogger({ toFile: false });
    const logger = new JobLogger({ db, logger: pino });
    try {
      const jobs = [F.azureFabricSenior];
      const searchFn = async () => ({ jobs, duplicates: [], errors: [] });
      const deps = { searchFn, now: F.NOW, stamp: 's' };

      const engineer = { ...base, root };
      const first = await runPipeline({ config: engineer, db, logger, mode: 'DRY_RUN', deps });
      expect(first.counters.jobs_scored).toBeGreaterThan(0);
      const engineerScore = db.getJob(F.azureFabricSenior.id).score;

      // Same posting, same run mode: without a config change it is skipped.
      const again = await runPipeline({ config: engineer, db, logger, mode: 'DRY_RUN', deps });
      expect(again.counters.jobs_skipped_unchanged).toBe(1);

      // Now the candidate becomes a nurse. The posting has not changed at all.
      const nurse = {
        ...base,
        root,
        candidate: {
          ...base.candidate,
          targetTitles: ['Registered Nurse', 'ICU Nurse'],
          technicalStack: { core: ['ACLS', 'BLS', 'Epic', 'Triage'], background: [], growth: [] },
          domainExperience: ['Healthcare'],
        },
      };
      const switched = await runPipeline({ config: nurse, db, logger, mode: 'DRY_RUN', deps });
      expect(switched.counters.jobs_skipped_unchanged).toBe(0);
      const nurseScore = db.getJob(F.azureFabricSenior.id).score;
      expect(nurseScore).not.toBe(engineerScore);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ══════════════════ 11. stated constraints govern results ══════════════════ */

describe('the constraints a user states actually filter', () => {
  const job = (over = {}) => normalizeJob({
    source: 'greenhouse', company: 'Acme', title: 'Data Engineer', sourceJobId: 'c1',
    postedAt: F.azureFabricSenior.postedAt, jdText: 'Build pipelines.', ...over,
  });

  it('drops an employer the user ruled out', () => {
    const candidate = { prohibited: { employers: ['StaffCo'], terms: [] } };
    const r = checkSearchConstraints(job({ company: 'StaffCo Staffing' }), candidate);
    expect(r.violated).toBe(true);
    expect(r.category).toBe('excluded_employer');
    // ...and does not drop an unrelated employer.
    expect(checkSearchConstraints(job(), candidate).violated).toBe(false);
  });

  it('drops a term the user ruled out', () => {
    const candidate = { prohibited: { employers: [], terms: ['on-call'] } };
    expect(checkSearchConstraints(job({ jdText: 'Rotating on-call required.' }), candidate).category)
      .toBe('excluded_term');
  });

  it('drops an excluded LOCATION instead of merely docking six points', () => {
    const candidate = { locationPreferences: { excludedLocations: ['Dallas'] } };
    expect(checkSearchConstraints(job({ location: 'Dallas, TX' }), candidate).category)
      .toBe('excluded_location');
  });

  it('no longer lets the word "remote" bypass that check entirely', () => {
    // Measured: a location containing "remote" skipped the exclusion outright.
    const candidate = { locationPreferences: { excludedLocations: ['Dallas'], remote: true } };
    // A genuinely remote posting is still exempt — ruling out a city is a
    // statement about GOING there...
    expect(checkSearchConstraints(job({ location: 'Remote (US)' }), candidate).violated).toBe(false);
    // ...but geography scoring no longer awards full marks to an excluded city
    // just because the string mentions remote somewhere.
    const scored = scoreJob(job({ location: 'Dallas, TX' }), {
      scoring: base.scoring, sponsorship: { status: 'Unconfirmed' },
      candidate: { ...base.candidate, locationPreferences: { ...base.candidate.locationPreferences, excludedLocations: ['Dallas'] } },
      now: F.NOW,
    });
    expect(scored.breakdown.geographyFit.points).toBe(0);
  });

  it('honours a minimum contract length only when the posting states one', () => {
    const candidate = { employmentPreferences: { types: ['contract'], minContractMonths: 12 } };
    expect(checkSearchConstraints(
      job({ jdText: '3 month contract.' }), candidate, { employmentCategory: 'contract' },
    ).category).toBe('contract_too_short');
    // Silence is not a violation.
    expect(checkSearchConstraints(
      job({ jdText: 'Contract role.' }), candidate, { employmentCategory: 'contract' },
    ).violated).toBe(false);
  });

  it('honours a salary floor only when the posting PUBLISHES pay below it', () => {
    const candidate = { salaryPreference: { minAnnualUSD: 150000 } };
    const low = job({ rawMetadata: { compensation: '$90,000 - $110,000 per year' } });
    expect(checkSearchConstraints({ ...low, rawMetadata: { compensation: '$90,000 - $110,000 per year' } }, candidate).category)
      .toBe('below_salary_floor');
    // A range that REACHES the floor is negotiable, not a violation.
    expect(checkSearchConstraints(
      { ...low, rawMetadata: { compensation: '$140,000 - $180,000' } }, candidate,
    ).violated).toBe(false);
    // An unpublished salary is unknown, and unknown never filters.
    expect(checkSearchConstraints(job(), candidate).violated).toBe(false);
  });

  it('parses the pay shapes employers actually publish, and nothing else', () => {
    expect(parseAnnualSalary('$120,000 - $150,000 a year')).toEqual({ min: 120000, max: 150000 });
    expect(parseAnnualSalary('$60/hr')).toEqual({ min: 124800, max: 124800 });
    expect(parseAnnualSalary('$120k')).toEqual({ min: 120000, max: 120000 });
    // Not salaries.
    expect(parseAnnualSalary('Posted 2024. Requisition 401.')).toBe(null);
    expect(parseAnnualSalary('')).toBe(null);
  });

  it('reads a contract duration only from a duration phrase', () => {
    expect(parseContractMonths('6 month contract')).toBe(6);
    expect(parseContractMonths('6-12 month engagement')).toBe(12);
    expect(parseContractMonths('2 year contract')).toBe(24);
    expect(parseContractMonths('We have 5 offices')).toBe(null);
  });
});

/* ══════════════════ 12. a career change is not an impostor ════════════════ */

describe('a deliberate career change is not treated as the wrong person', () => {
  const taxonomy = loadRoleFamilies(REPO);

  it('lets the SAME NAME in a new field through the preflight gate', () => {
    // compareToActiveProfile marks this `different` with LOW confidence and says
    // in its own reasons that it is more likely a career change — and preflight
    // rejected every `different` regardless, blocking exactly the users the
    // feature exists for.
    const nurseResume = [
      'Dana Okafor', 'Registered Nurse', 'dana@example.com',
      'Experience', 'Registered Nurse | Mercy General', 'Raleigh, NC | 2019 - Present',
      'Skills', 'Clinical: ACLS, BLS, Epic, Triage, Patient Assessment',
    ];
    const activeEngineer = normalizeProfile({
      id: 'dana-data', identity: { fullName: 'Dana Okafor' },
      background: { currentRoles: ['Senior Data Engineer'], skills: ['Databricks', 'PySpark', 'SQL'] },
      searchIntent: { targetRoles: ['Senior Data Engineer'], skillsToKeep: ['Databricks', 'PySpark', 'SQL'] },
    });
    const comparison = compareToActiveProfile(
      buildBackground(nurseResume), activeEngineer, taxonomy,
    );
    expect(comparison.relation).toBe('different');
    expect(comparison.confidence).toBe('low');
    expect(isBlockingResumeMismatch(comparison)).toBe(false);
  });

  it('still blocks a resume that names somebody else', () => {
    const someoneElse = [
      'Priya Raman', 'Registered Nurse', 'priya@example.com',
      'Experience', 'Registered Nurse | Mercy General', 'Raleigh, NC | 2019 - Present',
      'Skills', 'Clinical: ACLS, BLS, Epic',
    ];
    const activeEngineer = normalizeProfile({
      id: 'dana-data', identity: { fullName: 'Dana Okafor' },
      background: { currentRoles: ['Senior Data Engineer'], skills: ['Databricks', 'PySpark'] },
      searchIntent: { targetRoles: ['Senior Data Engineer'], skillsToKeep: ['Databricks', 'PySpark'] },
    });
    const comparison = compareToActiveProfile(buildBackground(someoneElse), activeEngineer, taxonomy);
    expect(comparison.relation).toBe('different');
    expect(comparison.confidence).toBe('high');
    expect(isBlockingResumeMismatch(comparison)).toBe(true);
  });
});

/* ══════════════════ 16. activation preserves what the user tuned ══════════ */

describe('activating a profile does not discard custom scoring', () => {
  const derived = () => deriveFromProfile(normalizeProfile({
    id: 'p', searchIntent: { targetRoles: ['Data Engineer'], skillsToKeep: ['SQL'] },
  }), { taxonomy: loadRoleFamilies(REPO) });

  it('keeps a category the user added themselves', () => {
    const mine = { id: 'complianceDepth', label: 'Compliance', weight: 9, keywords: ['hipaa', 'sox'] };
    const merged = applyScoring({ categories: [mine] }, derived());
    expect(merged.categories.find((c) => c.id === 'complianceDepth')).toEqual(mine);
    // The generated ones are still there, and marked as generated.
    expect(merged.categories.find((c) => c.id === 'coreSkills').derived).toBe(true);
  });

  it('keeps a weight the user changed on a generated category', () => {
    const tuned = { id: 'coreSkills', label: 'Core skills', weight: 42, fullAt: 3, from: 'technicalStack', derived: true };
    const merged = applyScoring({ categories: [tuned] }, derived());
    const core = merged.categories.find((c) => c.id === 'coreSkills');
    expect(core.weight).toBe(42);
    expect(core.fullAt).toBe(3);
    // ...while still following the profile for its terms.
    expect(core.from).toBe('technicalStack');
  });

  it('still generates the full set on a config that has none', () => {
    const merged = applyScoring({}, derived());
    expect(merged.categories.map((c) => c.id).sort()).toEqual(['coreSkills', 'domainFit', 'titleFit']);
  });
});

/* ══════════════════ 18. one seniority ladder ══════════════════════════════ */

describe('seniority is read consistently across the whole ladder', () => {
  const at = (title, seniority) => scoreJob(
    normalizeJob({
      source: 'greenhouse', company: 'Acme', title, sourceJobId: `s-${title}`,
      postedAt: F.azureFabricSenior.postedAt, jdText: 'Work.',
    }),
    {
      scoring: base.scoring, sponsorship: { status: 'Unconfirmed' },
      candidate: { ...base.candidate, seniority }, now: F.NOW,
    },
  ).breakdown.seniorityFit;

  it('recognizes the levels the candidate side has always ranked', () => {
    // Job-level detection knew only principal/staff, lead/manager, senior,
    // junior/entry and mid-level, so these read as "seniority unstated".
    for (const title of ['Director of Engineering', 'VP of Data', 'Associate Analyst', 'Data Intern']) {
      expect(at(title, 'senior').matched.join(' '), title).not.toMatch(/unstated/);
    }
  });

  it('puts staff level with lead, not with principal', () => {
    expect(at('Staff Engineer', 'lead').matched.join(' ')).toMatch(/seniority match/);
  });

  it('scores a director role best for a director', () => {
    const forDirector = at('Director of Engineering', 'director').points;
    const forEntry = at('Director of Engineering', 'entry').points;
    expect(forDirector).toBeGreaterThan(forEntry);
  });
});

/* ══════════════════ 14. broad views do not block the server ═══════════════ */

describe('the board pages large result sets without decorating all of them', () => {
  let db;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    for (let i = 0; i < 400; i += 1) {
      db.upsertJob({
        id: `j-${String(i).padStart(4, '0')}`,
        source: 'greenhouse',
        company: `Co ${i % 7}`,
        title: `Engineer ${i}`,
        location: 'Remote',
        url: `https://example.com/${i}`,
        // Heavy ties on purpose: ties are the norm on real data, and they are
        // what makes an untiebroken sort page inconsistently.
        score: i % 5,
        tier: 'Queue',
        status: i % 2 === 0 ? 'discarded' : 'scored',
        posted_at: '2026-09-01T00:00:00Z',
        created_at: '2026-09-01T00:00:00Z',
        updated_at: '2026-09-01T00:00:00Z',
      });
    }
  });
  afterEach(() => db.close());

  /** The same db with the paged read hidden, which forces the in-memory path. */
  const slowView = (real) => new Proxy(real, {
    get(target, key) {
      if (key === 'listJobsSummaryPage' || key === 'countJobs') return undefined;
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  it('returns exactly what the in-memory path would return', () => {
    const now = new Date('2026-09-18T00:00:00Z');
    for (const sort of ['score', 'posted', 'updated', 'discovered']) {
      for (const [limit, offset] of [[25, 0], [10, 25], [50, 350]]) {
        const fast = boardPage(db, { includeClosed: true, sort, limit, offset, now });
        const slow = boardPage(slowView(db), { includeClosed: true, sort, limit, offset, now });
        expect(fast.total, `${sort} total`).toBe(slow.total);
        expect(fast.jobs.map((j) => j.id), `${sort} ${limit}@${offset}`)
          .toEqual(slow.jobs.map((j) => j.id));
      }
    }
  });

  it('pages without repeating or skipping a row, even with heavy ties', () => {
    const now = new Date('2026-09-18T00:00:00Z');
    const seen = [];
    for (let offset = 0; offset < 400; offset += 50) {
      seen.push(...boardPage(db, { includeClosed: true, limit: 50, offset, now }).jobs.map((j) => j.id));
    }
    expect(seen).toHaveLength(400);
    expect(new Set(seen).size).toBe(400);
  });

  it('falls back to the full pipeline the moment a filter is present', () => {
    const now = new Date('2026-09-18T00:00:00Z');
    for (const filters of [{ q: 'Engineer 1' }, { fit: 'strong' }, { view: 'ready' }, { sort: 'company' }, { withViewCounts: true }]) {
      const fast = boardPage(db, { includeClosed: true, limit: 20, now, ...filters });
      const slow = boardPage(slowView(db), { includeClosed: true, limit: 20, now, ...filters });
      expect(fast.jobs.map((j) => j.id), JSON.stringify(filters)).toEqual(slow.jobs.map((j) => j.id));
      expect(fast.total, JSON.stringify(filters)).toBe(slow.total);
    }
  });
});
