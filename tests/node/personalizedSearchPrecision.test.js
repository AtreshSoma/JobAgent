/**
 * "FIND NEW JOBS" LOOKS FOR THIS PERSON'S ROLE, NOT THEIR WHOLE FIELD.
 *
 * Role-family expansion exists so that someone who types "Data Engineer" also
 * matches the ways employers name that job. It got there by admitting any
 * sibling role sharing one significant token with a target role — and in a
 * family whose every role contains the word "data", that is the entire family.
 *
 * Measured on the live profile, three stated roles expanded to twenty-three
 * target titles, among them Data Coordinator, Data Steward, Database
 * Administrator, Quantitative Analyst, Reporting Analyst and Data Analyst.
 * That list is not inert: `classifyTitleFit` accepts a target title verbatim
 * and DECISIVELY, before any stack, domain or family test runs, so each of
 * those became an unconditional pass. Against 112,108 real postings in the
 * local corpus the old list gave 2,718 postings a decisive accept that the
 * tightened one does not.
 *
 * The tests below pin the two ideas that replaced the single shared-token test:
 * CRAFT (build vs analyze vs coordinate), and SUBJECT the profile can evidence.
 * Both are read from the taxonomy and the profile, so neither names a
 * profession — which is why the same rules are exercised here against a nurse,
 * a marketer and a regulatory specialist as well as an engineer.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { normalizeProfile } from '../../src/profile/model.js';
import { deriveFromProfile } from '../../src/profile/derive.js';
import { buildProfileVocabulary, classifyTitleFit, titleFitPriority } from '../../src/scoring/profileFit.js';
import { headIndex, craftOfRole, loadRoleFamilies } from '../../src/profile/roleFamilies.js';

const REPO = process.cwd();

const DATA_ENGINEER = normalizeProfile({
  id: 'dana-data', label: 'Dana — Senior Data Engineer',
  identity: { fullName: 'Dana Okafor' },
  background: {
    currentRoles: ['Senior Data Engineer'], seniority: 'senior',
    skills: ['Azure', 'Azure Data Factory', 'Databricks', 'PySpark', 'Python', 'SQL', 'Power BI'],
  },
  searchIntent: {
    targetRoles: ['Senior Data Engineer', 'Data Engineer', 'Analytics Engineer'], seniority: 'senior',
    skillsToKeep: ['Azure', 'Azure Data Factory', 'Databricks', 'PySpark', 'Python', 'SQL', 'Power BI'],
  },
});

const NURSE = normalizeProfile({
  id: 'priya-nurse', label: 'Priya — Registered Nurse',
  background: { currentRoles: ['Registered Nurse'], seniority: 'mid', skills: ['ACLS', 'Epic', 'triage'] },
  searchIntent: {
    targetRoles: ['Registered Nurse'], seniority: 'mid',
    skillsToKeep: ['ACLS', 'Epic', 'triage', 'patient care'],
  },
});

const derive = (profile) => deriveFromProfile(profile, { root: REPO }).candidate;
const vocabFor = (profile) => buildProfileVocabulary(derive(profile), { root: REPO });

describe('the expansion admits variations of the role, not the whole family', () => {
  it('drops family siblings that are a different CRAFT', () => {
    // This profile asked to BUILD. Analyzing, coordinating and administering
    // data are different jobs that happen to share its vocabulary — which is
    // precisely why a shared-token test could not tell them apart.
    const titles = derive(DATA_ENGINEER).targetTitles.join(' | ');
    for (const other of [
      'Data Analyst', 'Data Scientist', 'Reporting Analyst', 'Quantitative Analyst',
      'Data Coordinator', 'Data Steward', 'Database Administrator',
      'Analytics Manager', 'Analytics Consultant',
    ]) {
      expect(titles).not.toContain(other);
    }
  });

  it('drops same-craft siblings whose SUBJECT the profile cannot evidence', () => {
    // "Machine Learning Engineer" builds, and sits in this family. Nothing in
    // the profile evidences machine learning, so it is somebody else's job.
    expect(derive(DATA_ENGINEER).targetTitles.join(' | ')).not.toContain('Machine Learning Engineer');
  });

  it('keeps same-craft siblings whose subject the profile DOES evidence', () => {
    const { adjacentTitles } = derive(DATA_ENGINEER);
    // "data" is shared with a stated role.
    expect(adjacentTitles).toContain('Data Platform Engineer');
    expect(adjacentTitles).toContain('Data Warehouse Engineer');
    expect(adjacentTitles).toContain('Data Architect');
    // "bi" is evidenced by Power BI — and the taxonomy states that "business
    // intelligence" and "bi" are the same term, so both spellings are kept.
    expect(adjacentTitles).toContain('BI Engineer');
    expect(adjacentTitles).toContain('Business Intelligence Engineer');
  });

  it('asks the job boards ONLY for the roles that were actually stated', () => {
    // Recognizing an adjacent title is free. ASKING a board for one is a
    // request per phrase per source per run, and it is how a personalized
    // search starts returning a whole field.
    const { searchPhrases } = deriveFromProfile(DATA_ENGINEER, { root: REPO });
    expect(searchPhrases).toEqual(['data engineer']);
    expect(searchPhrases.join(' ')).not.toMatch(/architect|warehouse|platform|intelligence/i);
  });
});

describe('a stated role decides; an adjacent one only contributes', () => {
  it('accepts a stated role decisively and ranks it above everything else', () => {
    const vocab = vocabFor(DATA_ENGINEER);
    const verdict = classifyTitleFit('Senior Data Engineer', vocab);
    expect(verdict.verdict).toBe('accept');
    expect(verdict.signals.some((s) => s.startsWith('title:'))).toBe(true);
    expect(titleFitPriority('Senior Data Engineer', vocab)).toBe(4);
  });

  it('accepts an adjacent role but ranks it BELOW a stated one', () => {
    const vocab = vocabFor(DATA_ENGINEER);
    const verdict = classifyTitleFit('Data Platform Engineer', vocab);
    expect(verdict.verdict).toBe('accept');
    // Marked as adjacent, so a limited description budget is spent on the
    // roles this person actually asked for first.
    expect(verdict.signals.some((s) => s.startsWith('title-adjacent:'))).toBe(true);
    expect(titleFitPriority('Data Platform Engineer', vocab))
      .toBeLessThan(titleFitPriority('Senior Data Engineer', vocab));
  });

  it('still rejects another field outright', () => {
    const vocab = vocabFor(DATA_ENGINEER);
    for (const other of ['Registered Nurse', 'Marketing Manager', 'Frontend Engineer', 'Truck Driver']) {
      expect(classifyTitleFit(other, vocab).verdict).toBe('reject');
    }
  });

  it('treats a candidate.json with no tiers as all-anchors, unchanged', () => {
    // A hand-written config, or one saved before the split existed, has neither
    // key. Everything it lists must stay decisive or the upgrade would silently
    // demote every title the user chose themselves.
    const vocab = buildProfileVocabulary({
      targetTitles: ['Widget Inspector'], seniority: 'mid',
    }, { root: REPO });
    expect(vocab.anchorTitles).toContain('widget inspector');
    expect(titleFitPriority('Senior Widget Inspector', vocab)).toBe(4);
  });
});

describe('a title the user adopts themselves is treated as one they stated', () => {
  it('adds an adopted title to the DECISIVE tier, not just to the union', async () => {
    const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { adoptResumeEvidence } = await import('../../src/config/profileStore.js');

    const root = mkdtempSync(join(tmpdir(), 'jobagent-adopt-'));
    try {
      mkdirSync(join(root, 'config', 'schemas'), { recursive: true });
      copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.example.json'));
      copyFileSync(
        join(REPO, 'config', 'schemas', 'candidate.schema.json'),
        join(root, 'config', 'schemas', 'candidate.schema.json'),
      );
      // A profile with the two tiers already set, as activation writes them.
      const candidate = derive(DATA_ENGINEER);
      writeFileSync(join(root, 'config', 'candidate.json'), JSON.stringify(candidate, null, 2));

      const { addedTitles } = adoptResumeEvidence(root, { titles: ['Lakehouse Developer'] });
      expect(addedTitles).toEqual(['Lakehouse Developer']);

      const after = JSON.parse(readFileSync(join(root, 'config', 'candidate.json'), 'utf8'));
      expect(after.targetTitles).toContain('Lakehouse Developer');
      // The point: only anchors are decisive. Writing the union alone left a
      // title the user had just chosen ranking like an unrecognized one.
      expect(after.anchorTitles).toContain('Lakehouse Developer');

      const vocab = buildProfileVocabulary(after, { root: REPO });
      expect(titleFitPriority('Lakehouse Developer', vocab))
        .toBe(titleFitPriority('Data Engineer', vocab));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the rules are read from the taxonomy, not written for one profession', () => {
  it('separates GENERIC head nouns from the names of professions', () => {
    const idx = headIndex(loadRoleFamilies(REPO));
    // Used across many families, so they say what KIND of work a role is.
    for (const generic of ['engineer', 'analyst', 'manager', 'specialist', 'coordinator']) {
      expect(idx.generic.has(generic)).toBe(true);
    }
    // Used by one family, so each IS a profession and is its own craft.
    for (const specific of ['nurse', 'accountant', 'chef', 'electrician', 'attorney']) {
      expect(idx.specific.has(specific)).toBe(true);
    }
  });

  it('reads the head noun from the role AS WRITTEN, not seniority-stripped', () => {
    // Several head nouns are also level words. Stripping the level off
    // "Regulatory Affairs Associate" leaves "regulatory affairs", which names a
    // department, not a job — and as a title would match everything it files.
    const idx = headIndex(loadRoleFamilies(REPO));
    expect(craftOfRole('regulatory affairs associate', idx).head).toBe('associate');
    expect(craftOfRole('data platform engineer', idx).head).toBe('engineer');
    expect(craftOfRole('registered nurse', idx).head).toBe('nurse');
  });

  it('offers a nurse nursing roles, and nothing else from the clinic', () => {
    const { adjacentTitles, targetTitles } = derive(NURSE);
    expect(adjacentTitles).toContain('Nurse Practitioner');
    expect(adjacentTitles).toContain('Clinical Nurse Specialist');
    const all = targetTitles.join(' | ');
    for (const other of ['Physician', 'Pharmacist', 'Dentist', 'Paramedic', 'Case Manager']) {
      expect(all).not.toContain(other);
    }
  });

  it('does not offer a role a LEVEL above the one that was asked for', () => {
    const grad = normalizeProfile({
      id: 'morgan', label: 'Morgan — Marketing Coordinator',
      background: { currentRoles: ['Marketing Coordinator'], seniority: 'entry', skills: ['SEO'] },
      searchIntent: {
        targetRoles: ['Marketing Coordinator'], seniority: 'entry',
        skillsToKeep: ['SEO', 'Google Analytics', 'Canva'],
      },
    });
    const titles = derive(grad).targetTitles.join(' | ');
    // Specialist is one rung from Coordinator and is offered; Manager is two.
    expect(titles).toContain('Marketing Specialist');
    expect(titles).not.toMatch(/Marketing Manager|Marketing Director/);
  });

  it('gives two different professions two different searches', () => {
    const data = derive(DATA_ENGINEER).targetTitles.join(' ');
    const nurse = derive(NURSE).targetTitles.join(' ');
    expect(data).not.toMatch(/Nurse|Clinical/i);
    expect(nurse).not.toMatch(/Data|Analytics|Engineer/i);
  });
});
