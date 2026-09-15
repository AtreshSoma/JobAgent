/**
 * Regression guards for the findings in reports/audit/jobagent-audit-2026-09-14.
 *
 * Each block below reproduces a defect the audit demonstrated at runtime, so the
 * specific behaviour that made it possible cannot come back. The audit's own
 * observation was that none of these were covered — "no test covers
 * screening-answer correctness for qualified questions, which is why the §5 P0
 * is live" — so the tests matter as much as the fixes.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { answerScreeningQuestion, experienceSubject } from '../../src/apply/screeningQA.js';
import { isPlaceholderValue, findPlaceholders } from '../../src/config/placeholders.js';
import { singularize, normalizeForMatch } from '../../src/utils/textNormalize.js';
import { readJson } from '../../src/config/loadConfig.js';
import { deriveAppStatus, APP_STATUS, dashboardStats } from '../../src/dashboard/data.js';
import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { uploadCheckpoint } from '../../src/apply/applicationState.js';
import { fixtureCandidate, fixtureScreeningAnswers } from './helpers/testConfig.js';

describe('§5 P0 — years-of-experience answers are never fabricated', () => {
  // The three questions the audit ran against the live config. Every one
  // returned "10+ years" at confidence 1.0.
  const QUALIFIED = [
    'How many years of experience do you have with SAP ABAP?',
    'How many years of management experience do you have?',
    'How many years of experience do you have in clinical trials?',
    'Years of experience with Kubernetes',
    'How many years have you worked with Salesforce?',
  ];

  it.each(QUALIFIED)('defers a qualified duration question: %s', (question) => {
    const r = answerScreeningQuestion(question, fixtureScreeningAnswers, { candidate: fixtureCandidate });
    expect(r.answered).toBe(false);
    expect(r.action).toBe('ask_user');
    expect(r.answer).toBe(null);
  });

  it('still answers an UNQUALIFIED career-total question', () => {
    for (const q of [
      'How many years of experience do you have?',
      'Total years of professional experience',
      'How many years of relevant experience do you have?',
    ]) {
      const r = answerScreeningQuestion(q, fixtureScreeningAnswers, { candidate: fixtureCandidate });
      expect(r.answered, q).toBe(true);
      expect(r.matchedId, q).toBe('years_experience');
    }
  });

  it('answers a qualified question from the per-skill record when one exists', () => {
    const r = answerScreeningQuestion(
      'How many years of experience do you have with Python?',
      fixtureScreeningAnswers,
      { candidate: fixtureCandidate },
    );
    expect(r.answered).toBe(true);
    expect(r.matchedId).toBe('skill_experience');
    expect(r.answer).toBe('8 years');
  });

  it('defers even when the question names a skill the candidate HAS but has not timed', () => {
    const candidate = { ...fixtureCandidate, skillExperience: {} };
    const r = answerScreeningQuestion(
      'How many years of experience do you have with Python?',
      fixtureScreeningAnswers, { candidate },
    );
    expect(r.answered).toBe(false);
  });

  it('a qualified question reaches the human even when unknownAction is "skip"', () => {
    const skipping = { ...fixtureScreeningAnswers, defaults: { unknownAction: 'skip' } };
    const r = answerScreeningQuestion(
      'How many years of experience do you have with COBOL?', skipping, { candidate: fixtureCandidate },
    );
    expect(r.action).toBe('ask_user'); // NOT 'skip' — a blank is honest, a guess is not
  });

  it('extracts the subject only when the question actually names one', () => {
    expect(experienceSubject('How many years of experience do you have with SAP ABAP?')).toBe('sap abap');
    expect(experienceSubject('How many years of experience do you have?')).toBe(null);
    expect(experienceSubject('What is your favourite database?')).toBe(null);
  });
});

describe('§5 P0 — shipped placeholder values are rejected', () => {
  it('flags every sentinel the example configs actually ship', () => {
    const candidate = readJson(join(process.cwd(), 'config', 'candidate.example.json'));
    const screeningAnswers = readJson(join(process.cwd(), 'config', 'screening_answers.example.json'));
    const { ok, placeholders } = findPlaceholders({ candidate, screeningAnswers });

    expect(ok).toBe(false);
    const paths = placeholders.map((p) => p.path);
    // The legally material ones specifically.
    expect(paths).toContain('workAuthorization.status');
    expect(paths).toContain('answers[id=require_sponsorship].answer');
    expect(paths).toContain('answers[id=work_authorization].answer');
  });

  it('does NOT flag a real profile', () => {
    expect(findPlaceholders({
      candidate: fixtureCandidate,
      screeningAnswers: fixtureScreeningAnswers,
    }).ok).toBe(true);
  });

  it.each([
    'Dana Whitfield', 'dana@fastmail.com', 'H-1B', 'Raleigh', '9195551234',
    'Yes, I will require sponsorship.', 'US Citizen',
  ])('treats a real value as real: %s', (value) => {
    expect(isPlaceholderValue(value)).toBe(false);
  });

  it.each([
    'YOUR truthful authorization status.', 'you@example.com', 'Your City',
    'US Citizen | Green Card | H-1B | OPT | ...', 'Jane Doe',
  ])('treats a template value as a placeholder: %s', (value) => {
    expect(isPlaceholderValue(value)).toBe(true);
  });
});

describe('§5 P1 — plural screening phrasings match', () => {
  it('answers both the singular and the plural form', () => {
    for (const q of [
      'What is your salary expectation?',
      'What are your salary expectations?',
      'What is your expected compensation?',
      'What are your salary requirements?',
    ]) {
      const r = answerScreeningQuestion(q, fixtureScreeningAnswers, { candidate: fixtureCandidate });
      expect(r.answered, q).toBe(true);
      expect(r.matchedId, q).toBe('salary_expectation');
    }
  });

  it('singularizes regular plurals and leaves ambiguous words alone', () => {
    expect(singularize('expectations')).toBe('expectation');
    expect(singularize('requirements')).toBe('requirement');
    expect(singularize('companies')).toBe('company');
    expect(singularize('matches')).toBe('match');
    // Must NOT be stemmed — over-stemming makes unrelated patterns collide.
    for (const w of ['class', 'status', 'analysis', 'various', 'previous', 'bonus']) {
      expect(singularize(w), w).toBe(w);
    }
  });

  it('normalizeForMatch keeps tech punctuation intact', () => {
    expect(normalizeForMatch('T-SQL and CI/CD skills')).toContain('t-sql');
    expect(normalizeForMatch('T-SQL and CI/CD skills')).toContain('ci/cd');
  });
});

describe('§4 P2 — unread jobs are not reported as scored', () => {
  it('maps needs_description to its own status, not SCORED', () => {
    // A provisional score IS set on these rows; that is what made them look judged.
    const row = { status: 'needs_description', score: 41, tier: null };
    expect(deriveAppStatus(row)).toBe(APP_STATUS.NEEDS_DESCRIPTION);
    expect(deriveAppStatus(row)).not.toBe(APP_STATUS.SCORED);
  });

  it('still reports a genuinely scored row as SCORED', () => {
    expect(deriveAppStatus({ status: 'scored', score: 72, tier: 'apply' })).toBe(APP_STATUS.SCORED);
  });
});

describe('§5 P2 — checkpoint paths are stripped on every platform', () => {
  it('keeps only the basename of a WINDOWS path on a POSIX host', () => {
    // node:path's basename() is the POSIX build here, where "\" is an ordinary
    // filename character — so the candidate's full path and name survived.
    const cp = uploadCheckpoint({ type: 'resume', path: 'C:\\private\\Candidate_Name_Resume.pdf' });
    expect(cp.fileName).toBe('Candidate_Name_Resume.pdf');
    expect(cp.fileName).not.toContain('\\');
    expect(cp.fileName).not.toContain('private');
  });

  it('keeps only the basename of a POSIX path', () => {
    expect(uploadCheckpoint({ type: 'resume', path: '/home/dana/apps/Resume.pdf' }).fileName).toBe('Resume.pdf');
  });
});

describe('§5 P2 — duplicate JSON keys are rejected, not silently dropped', () => {
  let dir;
  const write = (name, text) => {
    dir ??= mkdtempSync(join(tmpdir(), 'dupkey-'));
    const p = join(dir, name);
    writeFileSync(p, text, 'utf8');
    return p;
  };
  const cleanup = () => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; };

  it('throws on a repeated key in the same object', () => {
    try {
      const p = write('dup.json', '{"aliases": {"streaming": ["a"], "streaming": ["b"]}}');
      expect(() => readJson(p)).toThrow(/duplicate key/i);
    } finally { cleanup(); }
  });

  it('accepts the same key name in DIFFERENT objects', () => {
    try {
      const p = write('ok.json', '{"a": {"x": 1}, "b": {"x": 2}}');
      expect(readJson(p)).toEqual({ a: { x: 1 }, b: { x: 2 } });
    } finally { cleanup(); }
  });

  it('is not fooled by colons or quotes inside string values', () => {
    try {
      const p = write('strings.json', '{"a": "key: value", "b": "he said \\"hi\\""}');
      expect(() => readJson(p)).not.toThrow();
    } finally { cleanup(); }
  });

  it('every shipped config file is free of duplicate keys', () => {
    for (const f of [
      'scoring.json', 'exclusions.json', 'jobboards.json', 'cover_letter.json',
      'ats_resume.json', 'humanizer_patterns.json',
      'candidate.example.json', 'screening_answers.example.json',
    ]) {
      expect(() => readJson(join(process.cwd(), 'config', f)), f).not.toThrow();
    }
  });
});

describe('§4 P1 — "today" is the candidate\'s day, not the UTC day', () => {
  /**
   * The audit's measured case. 2026-09-15T00:07Z is 2026-09-14 20:07 in New
   * York: the UTC day has rolled over while the user's evening is still going.
   */
  const NOW = new Date('2026-09-15T00:07:00Z');
  /** Discovered 16:30 New York on the 14th — squarely inside the user's "today". */
  const DISCOVERED_AT = '2026-09-14T20:30:00.000Z';
  const EASTERN = { candidate: { location: { timezone: 'America/New_York' } } };

  function dbWithOneJob() {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({
      id: 'j1', company: 'Acme', title: 'Data Engineer', source: 'greenhouse',
      created_at: DISCOVERED_AT,
    });
    return db;
  }

  it('the UTC day loses the evening (this is the bug)', () => {
    const utc = dashboardStats(dbWithOneJob(), { now: NOW });
    expect(utc.totals.discoveredToday).toBe(0);
  });

  it('the candidate timezone keeps it (this is the fix)', () => {
    const eastern = dashboardStats(dbWithOneJob(), { now: NOW, config: EASTERN });
    expect(eastern.totals.discoveredToday).toBe(1);
  });

  it('falls back to UTC slicing for an invalid timezone rather than throwing', () => {
    expect(() => dashboardStats(dbWithOneJob(), {
      now: NOW, config: { candidate: { location: { timezone: 'Not/AZone' } } },
    })).not.toThrow();
  });

  it('caches per timezone, so changing the profile zone changes the answer', () => {
    const db = dbWithOneJob();
    const utc = dashboardStats(db, { now: NOW });
    const eastern = dashboardStats(db, { now: NOW, config: EASTERN });
    expect(utc.totals.discoveredToday).not.toBe(eastern.totals.discoveredToday);
  });
});

describe('§4 P1 — every run leaves a record', () => {
  it('writes a run_log row with counters and a duration, and serves it at /api/runs', async () => {
    const db = openDatabase({ path: ':memory:' });
    const dash = await startDashboard({
      config: { root: process.cwd() }, db, logger: null, port: 0,
      deps: {
        discoverFn: async () => ({
          counters: { jobs_found: 7, jobs_scored: 3, jobs_discarded: 2 }, errors: [], perSource: [],
        }),
      },
    });
    try {
      expect((await (await fetch(`${dash.url}/api/runs`)).json()).runs).toHaveLength(0);

      await fetch(`${dash.url}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phase: 'discover' }),
      });
      // The run is fire-and-forget; wait for it to close its row.
      for (let i = 0; i < 40; i += 1) {
        const { runs } = await (await fetch(`${dash.url}/api/runs`)).json();
        if (runs[0]?.ended_at) break;
        await new Promise((r) => { setTimeout(r, 25); });
      }

      const { runs } = await (await fetch(`${dash.url}/api/runs`)).json();
      expect(runs).toHaveLength(1);
      expect(runs[0].mode).toBe('discover');
      expect(runs[0].jobs_found).toBe(7);
      expect(runs[0].jobs_scored).toBe(3);
      expect(runs[0].started_at).toBeTruthy();
      expect(runs[0].ended_at).toBeTruthy();
      expect(typeof runs[0].durationMs).toBe('number');
    } finally {
      await dash.close();
    }
  }, 20000);

  it('updateRunLog UPSERTS, so a run whose opening insert was missed still records', () => {
    const db = openDatabase({ path: ':memory:' });
    // Exactly the old dashboard behaviour: close a run that was never opened.
    db.updateRunLog('never-inserted', { mode: 'discover', ended_at: '2026-09-15T00:00:00.000Z', jobs_found: 5 });
    const rows = db.listRunLogs({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].jobs_found).toBe(5);
  });
});
