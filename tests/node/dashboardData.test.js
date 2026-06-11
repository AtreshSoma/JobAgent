import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDatabase } from '../../src/logging/db.js';
import {
  deriveAppStatus, fitBucket, dashboardStats, listBoardJobs, jobDetail,
  applyDecision, approveJobPacket, rejectJobPacket, markSubmittedByHuman,
  APP_STATUS,
  gradeFromScore, postedConfidence, resumeStatusOf, progressFor,
  dashboardSections, setJobNote, buildExportRows, exportRowsToCsv, buildReports,
} from '../../src/dashboard/data.js';

const NOW = new Date('2026-06-04T12:00:00Z');
const TODAY = '2026-06-04T09:00:00Z';
const FRESH = '2026-06-04T01:00:00Z';   // within 24h of NOW
const OLD = '2026-05-20T00:00:00Z';

describe('deriveAppStatus precedence', () => {
  it('submitted always wins', () => {
    expect(deriveAppStatus({ applied: 1, user_decision: 'rejected', status: 'assist_blocked' }, null))
      .toBe(APP_STATUS.SUBMITTED);
  });
  it('user archive/reject beat pipeline states', () => {
    expect(deriveAppStatus({ user_decision: 'archived', score: 90 }, null)).toBe(APP_STATUS.ARCHIVED);
    expect(deriveAppStatus({ user_decision: 'rejected', status: 'prepared' }, null)).toBe(APP_STATUS.REJECTED);
  });
  it('assist outcomes beat approval state', () => {
    expect(deriveAppStatus({ status: 'assist_blocked' }, { approval_status: 'approved' }))
      .toBe(APP_STATUS.BLOCKED);
    expect(deriveAppStatus({ status: 'ready_for_submit' }, { approval_status: 'approved' }))
      .toBe(APP_STATUS.READY_FOR_SUBMIT);
  });
  it('approval queue states', () => {
    expect(deriveAppStatus({}, { approval_status: 'pending_review' })).toBe(APP_STATUS.NEEDS_REVIEW);
    expect(deriveAppStatus({}, { approval_status: 'approved' })).toBe(APP_STATUS.APPROVED);
    expect(deriveAppStatus({}, { approval_status: 'rejected' })).toBe(APP_STATUS.REJECTED);
  });
  it('shortlist, discard, scored, discovered fallbacks', () => {
    expect(deriveAppStatus({ user_decision: 'shortlisted', score: 70 }, null)).toBe(APP_STATUS.SHORTLISTED);
    expect(deriveAppStatus({ status: 'discarded' }, null)).toBe(APP_STATUS.DISCARDED);
    expect(deriveAppStatus({ score: 70 }, null)).toBe(APP_STATUS.SCORED);
    expect(deriveAppStatus({}, null)).toBe(APP_STATUS.DISCOVERED);
  });

  // Regression: unknown-date jobs used to be lumped into "discarded", hiding
  // them from review. They must surface as their own flagged status.
  it('flags unknown posting dates distinctly (not discarded)', () => {
    expect(deriveAppStatus({ status: 'unknown_date_review' }, null)).toBe(APP_STATUS.DATE_UNCONFIRMED);
  });

  it('user skips surface as skipped, below submitted/archive in precedence', () => {
    expect(deriveAppStatus({ status: 'skipped' }, null)).toBe(APP_STATUS.SKIPPED);
    expect(deriveAppStatus({ status: 'skipped', applied: 1 }, null)).toBe(APP_STATUS.SUBMITTED);
    expect(deriveAppStatus({ status: 'skipped', user_decision: 'archived' }, null)).toBe(APP_STATUS.ARCHIVED);
  });
});

describe('fitBucket', () => {
  it('maps tiers to buckets', () => {
    expect(fitBucket('Priority')).toBe('strong');
    expect(fitBucket('Apply')).toBe('strong');
    expect(fitBucket('Queue')).toBe('medium');
    expect(fitBucket('Near miss')).toBe('weak');
    expect(fitBucket('Discard')).toBe('no_fit');
    expect(fitBucket(null)).toBe('unscored');
  });
});

describe('stats, board, decisions against a seeded db', () => {
  let db;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({
      id: 'strong', company: 'Acme', title: 'Senior Data Engineer', url: 'http://a',
      source: 'greenhouse', score: 90, tier: 'Priority', sponsorship: 'Confirmed',
      status: 'prepared', posted_at: FRESH, application_packet_path: '/p/strong.json',
      matched_keywords: ['azure', 'pyspark'], missing_keywords: ['kafka'],
      explanation: 'Strong Azure + Fabric overlap; sponsorship confirmed.',
      created_at: TODAY,
    });
    db.insertApproval({ id: 'ap-strong', job_id: 'strong', packet_path: '/p/strong.json', approval_status: 'pending_review' });
    db.upsertJob({
      id: 'medium', company: 'Globex', title: 'BI Engineer', url: 'http://b',
      source: 'ashby', score: 65, tier: 'Queue', sponsorship: 'Likely', posted_at: OLD,
      created_at: TODAY,
    });
    db.upsertJob({
      id: 'nofit', company: 'Initech', title: 'Jr DE', url: 'http://c',
      source: 'manual', tier: 'Discard', status: 'discarded',
      discard_reason: 'junior role', posted_at: OLD, created_at: OLD,
    });
    db.upsertJob({
      id: 'done', company: 'Umbrella', title: 'DE', url: 'http://d', source: 'lever',
      score: 80, tier: 'Apply', applied: 1, applied_at: TODAY, status: 'submitted',
      application_packet_path: '/p/done.json', created_at: OLD,
    });
  });
  afterEach(() => db.close());

  it('dashboardStats breaks down sponsorship, daily progress, and next actions', () => {
    const s = dashboardStats(db, { now: NOW });
    expect(s.bySponsorship.Confirmed).toMatchObject({ count: 1, strong: 1 });
    expect(s.bySponsorship.Likely).toMatchObject({ count: 1 });
    // 7-day strip, oldest first, ends today.
    expect(s.daily).toHaveLength(7);
    expect(s.daily[6].day).toBe('2026-06-04');
    expect(s.daily[6].discovered).toBe(2);
    expect(s.daily[6].submitted).toBe(1);
    // Next actions: 1 pending review surfaces with its board filter.
    const review = s.nextActions.find((a) => a.text.includes('await your approval'));
    expect(review).toBeDefined();
    expect(review.filter).toEqual({ appStatus: APP_STATUS.NEEDS_REVIEW });
  });

  it('dashboardStats counts every tile correctly', () => {
    const s = dashboardStats(db, { now: NOW });
    expect(s.totals.jobsTracked).toBe(4);
    expect(s.totals.discoveredToday).toBe(2);   // strong + medium created today
    expect(s.totals.postedLast24h).toBe(1);     // strong
    expect(s.totals.strongFit).toBe(2);         // Priority + Apply
    expect(s.totals.mediumFit).toBe(1);
    expect(s.totals.pendingReview).toBe(1);
    expect(s.totals.submittedToday).toBe(1);
    expect(s.totals.submittedTotal).toBe(1);
    expect(s.bySource.greenhouse).toMatchObject({ found: 1, strong: 1, prepared: 1, submitted: 0 });
    expect(s.bySource.lever).toMatchObject({ found: 1, submitted: 1 });
    expect(s.byStatus[APP_STATUS.NEEDS_REVIEW]).toBe(1);
    expect(s.byStatus[APP_STATUS.SUBMITTED]).toBe(1);
  });

  it('listBoardJobs filters, hides closed by default, and sorts by score', () => {
    const rows = listBoardJobs(db, { now: NOW });
    // discarded job hidden by default
    expect(rows.map((r) => r.id)).toEqual(['strong', 'done', 'medium']);
    expect(rows[0].fit).toBe('strong');
    expect(rows[0].postedLast24h).toBe(true);

    expect(listBoardJobs(db, { now: NOW, fit: 'medium' }).map((r) => r.id)).toEqual(['medium']);
    expect(listBoardJobs(db, { now: NOW, last24h: true }).map((r) => r.id)).toEqual(['strong']);
    expect(listBoardJobs(db, { now: NOW, q: 'globex' }).map((r) => r.id)).toEqual(['medium']);
    expect(listBoardJobs(db, { now: NOW, source: 'ashby' }).map((r) => r.id)).toEqual(['medium']);
    expect(listBoardJobs(db, { now: NOW, appStatus: 'discarded' }).map((r) => r.id)).toEqual(['nofit']);
    expect(listBoardJobs(db, { now: NOW, hideClosed: false }).length).toBe(4);
    const byCompany = listBoardJobs(db, { now: NOW, sort: 'company' });
    expect(byCompany[0].company).toBe('Acme');
  });

  it('board rows parse keyword JSON and expose why-fit fields', () => {
    const [row] = listBoardJobs(db, { now: NOW, q: 'acme' });
    expect(row.matchedKeywords).toEqual(['azure', 'pyspark']);
    expect(row.missingKeywords).toEqual(['kafka']);
    expect(row.explanation).toContain('sponsorship confirmed');
    expect(row.appStatus).toBe(APP_STATUS.NEEDS_REVIEW);
  });

  it('jobDetail merges the packet JSON and flags unreadable packets', () => {
    const packet = {
      id: 'pk', ats: { platform: 'greenhouse' }, blockers: ['1 screening field(s) need user input'],
      resumeTailored: true, prefill: { plan: [{ label: 'Email', value: 'a@b.c', source: 'profile' }], needsUser: [{ label: 'Essay' }] },
      screeningPlan: { answered: [] }, stopBeforeSubmit: true, submitReady: false,
    };
    const detail = jobDetail(db, 'strong', { now: NOW, readFileImpl: () => JSON.stringify(packet) });
    expect(detail.packet.ats.platform).toBe('greenhouse');
    expect(detail.packet.prefillPlan).toHaveLength(1);
    expect(detail.packet.needsUser[0].label).toBe('Essay');
    expect(detail.packet.submitReady).toBe(false);

    const broken = jobDetail(db, 'strong', { now: NOW, readFileImpl: () => { throw new Error('gone'); } });
    expect(broken.packet.error).toContain('gone');
    expect(jobDetail(db, 'nope', { now: NOW })).toBeNull();
  });

  it('applyDecision validates input and round-trips through appStatus', () => {
    expect(applyDecision(db, 'medium', 'shortlisted').appStatus).toBe(APP_STATUS.SHORTLISTED);
    expect(applyDecision(db, 'medium', 'rejected').appStatus).toBe(APP_STATUS.REJECTED);
    expect(applyDecision(db, 'medium', 'clear').userDecision).toBeNull();
    expect(() => applyDecision(db, 'medium', 'maybe')).toThrow(/invalid decision/);
    expect(() => applyDecision(db, 'ghost', 'shortlisted')).toThrow(/unknown job/);
  });

  it('approve/reject packet go through the approval queue', () => {
    const ok = approveJobPacket(db, 'strong');
    expect(ok.status).toBe('approved');
    expect(db.getApproval(ok.approvalId).approved_by_user).toBe(1);
    expect(rejectJobPacket(db, 'strong').status).toBe('rejected');
    expect(() => approveJobPacket(db, 'medium')).toThrow(/no prepared packet/);
  });

  it('markSubmittedByHuman is the only path to submitted', () => {
    const r = markSubmittedByHuman(db, 'medium', { now: NOW });
    expect(r.appStatus).toBe(APP_STATUS.SUBMITTED);
    const job = db.getJob('medium');
    expect(Number(job.applied)).toBe(1);
    expect(job.applied_at).toBe(NOW.toISOString());
    expect(() => markSubmittedByHuman(db, 'ghost')).toThrow(/unknown job/);
  });

  it('db.setUserDecision rejects unknown decisions', () => {
    expect(() => db.setUserDecision('medium', 'banana')).toThrow(/invalid user decision/);
  });

  it('jobDetail includes the audit-trail events, newest first', () => {
    db.insertEvent({ id: 'e1', job_id: 'strong', event_type: 'SCORE_EXPLAINED', message: '90/100', created_at: '2026-06-04T01:00:00Z' });
    db.insertEvent({ id: 'e2', job_id: 'strong', event_type: 'APPROVAL_REQUIRED', message: 'packet prepared', created_at: '2026-06-04T02:00:00Z' });
    const detail = jobDetail(db, 'strong', { now: NOW, readFileImpl: () => { throw new Error('no packet'); } });
    expect(detail.events.map((e) => e.type)).toEqual(['APPROVAL_REQUIRED', 'SCORE_EXPLAINED']);
  });

  it('board rows expose persisted assist results', () => {
    db.upsertJob({ id: 'strong', assist_filled_count: 7, assist_blockers: ['login wall'] });
    const [row] = listBoardJobs(db, { now: NOW, q: 'acme' });
    expect(row.assistFilledCount).toBe(7);
    expect(row.assistBlockers).toEqual(['login wall']);
  });
});

describe('recordAssistResult persistence', () => {
  it('stores status, filled count, and blockers from an assist result', async () => {
    const { recordAssistResult } = await import('../../src/cli/commands.js');
    const db = openDatabase({ path: ':memory:' });
    try {
      db.upsertJob({ id: 'j', company: 'X', title: 'DE', url: 'http://x' });
      recordAssistResult(db, 'j', {
        status: 'assist_blocked',
        filled: [{ field: 'email' }, { field: 'phone' }],
        blockers: ['captcha detected — needs you'],
      });
      const job = db.getJob('j');
      expect(job.status).toBe('assist_blocked');
      expect(job.assist_filled_count).toBe(2);
      expect(JSON.parse(job.assist_blockers)).toEqual(['captcha detected — needs you']);
    } finally {
      db.close();
    }
  });
});

describe('derived signals: grade, posted confidence, resume status, progress', () => {
  it('gradeFromScore maps scores to A–F with recommend flag', () => {
    expect(gradeFromScore(90)).toMatchObject({ letter: 'A', recommend: true });
    expect(gradeFromScore(78)).toMatchObject({ letter: 'B', recommend: true });
    expect(gradeFromScore(66)).toMatchObject({ letter: 'C', recommend: true });
    expect(gradeFromScore(55)).toMatchObject({ letter: 'D', recommend: false });
    expect(gradeFromScore(20)).toMatchObject({ letter: 'F', recommend: false });
    expect(gradeFromScore(null)).toBeNull();
  });

  it('postedConfidence flags missing/unparsed dates', () => {
    expect(postedConfidence({ posted_at: '2026-06-04T00:00:00Z' })).toBe('confirmed');
    expect(postedConfidence({ posted_at: null })).toBe('unconfirmed');
    expect(postedConfidence({ status: 'unknown_date_review', posted_at: 'x' })).toBe('unconfirmed');
  });

  it('resumeStatusOf reflects tailored vs prepared vs none', () => {
    expect(resumeStatusOf({ resume_pdf_path: '/r.pdf' })).toBe('tailored');
    expect(resumeStatusOf({ application_packet_path: '/p.json' })).toBe('prepared');
    expect(resumeStatusOf({})).toBe('none');
  });

  it('progressFor places linear stages and off-ramps', () => {
    expect(progressFor(APP_STATUS.DISCOVERED)).toMatchObject({ index: 0, offRamp: false });
    expect(progressFor(APP_STATUS.NEEDS_REVIEW)).toMatchObject({ stage: 'prepared', offRamp: false });
    expect(progressFor(APP_STATUS.SUBMITTED)).toMatchObject({ percent: 100, offRamp: false });
    expect(progressFor(APP_STATUS.BLOCKED)).toMatchObject({ offRamp: true, stage: 'blocked' });
  });
});

describe('dashboardStats freshness metrics', () => {
  it('reports discoveredLast24h and lastDiscoveryAt distinctly from postedLast24h', () => {
    const db = openDatabase({ path: ':memory:' });
    try {
      // Found within 24h, but the employer posted it weeks ago.
      db.upsertJob({ id: 'a', company: 'A', title: 'DE', url: 'u', score: 80, tier: 'Apply',
        created_at: '2026-06-04T06:00:00Z', posted_at: OLD });
      // Found long ago, but posted within 24h.
      db.upsertJob({ id: 'b', company: 'B', title: 'DE', url: 'u', score: 70, tier: 'Queue',
        created_at: OLD, posted_at: FRESH });
      const s = dashboardStats(db, { now: NOW });
      expect(s.totals.discoveredLast24h).toBe(1);          // only 'a'
      expect(s.totals.postedLast24h).toBe(1);              // only 'b'
      expect(s.lastDiscoveryAt).toBe('2026-06-04T06:00:00Z');
      // nextActions must NOT nag to discover when something was found in 24h.
      expect(s.nextActions.some((x) => /No new jobs found/.test(x.text))).toBe(false);
    } finally { db.close(); }
  });

  it('nudges to run discovery only when nothing was found in the last 24h', () => {
    const db = openDatabase({ path: ':memory:' });
    try {
      db.upsertJob({ id: 'old', company: 'A', title: 'DE', url: 'u', created_at: OLD, posted_at: OLD });
      const s = dashboardStats(db, { now: NOW });
      expect(s.totals.discoveredLast24h).toBe(0);
      expect(s.nextActions.some((x) => /No new jobs found/.test(x.text))).toBe(true);
    } finally { db.close(); }
  });
});

describe('dashboardSections', () => {
  let db;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'ready', company: 'Ready Co', title: 'DE', url: 'u', score: 88, tier: 'Apply',
      status: 'ready_for_submit', application_packet_path: '/p.json', created_at: TODAY });
    db.upsertJob({ id: 'rev', company: 'Review Co', title: 'DE', url: 'u', score: 82, tier: 'Apply',
      application_packet_path: '/p2.json', created_at: TODAY });
    db.insertApproval({ id: 'ap', job_id: 'rev', packet_path: '/p2.json', approval_status: 'pending_review' });
    db.upsertJob({ id: 'blk1', company: 'Block Co', title: 'DE', url: 'u', score: 80, tier: 'Apply',
      status: 'assist_blocked', assist_blockers: ['captcha detected — needs you'], created_at: TODAY });
    db.upsertJob({ id: 'blk2', company: 'Wall Co', title: 'DE', url: 'u', score: 79, tier: 'Apply',
      status: 'assist_blocked', assist_blockers: ['login required to continue'], created_at: TODAY });
    db.upsertJob({ id: 'best', company: 'Best Co', title: 'DE', url: 'u', score: 95, tier: 'Priority', created_at: TODAY });
    db.upsertJob({ id: 'sub', company: 'Done Co', title: 'DE', url: 'u', score: 90, tier: 'Apply',
      applied: 1, applied_at: TODAY, status: 'submitted', created_at: OLD });
  });
  afterEach(() => db.close());

  it('builds curated, sorted, action-oriented sections', () => {
    const sec = dashboardSections(db, { now: NOW });
    expect(sec.readyForSubmit.map((r) => r.id)).toContain('ready');
    expect(sec.needsReview.map((r) => r.id)).toEqual(['rev']);
    expect(sec.recentlySubmitted.map((r) => r.id)).toEqual(['sub']);
    // Best matches: strong + recommended + not closed; excludes the submitted one.
    expect(sec.bestMatches.map((r) => r.id)).toContain('best');
    expect(sec.bestMatches.map((r) => r.id)).not.toContain('sub');
    // Today's priorities surface the ready job first.
    expect(sec.todaysPriorities[0].id).toBe('ready');
    expect(sec.counts.blocked).toBe(2);
  });

  it('groups blocked jobs by human-meaningful reason', () => {
    const sec = dashboardSections(db, { now: NOW });
    const reasons = sec.blockedByReason.map((b) => b.reason);
    expect(reasons).toContain('CAPTCHA / bot wall');
    expect(reasons).toContain('Login / account required');
    expect(sec.blockedByReason.reduce((n, b) => n + b.count, 0)).toBe(2);
  });
});

describe('notes + rich CSV export', () => {
  let db;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'j1', company: 'Acme, Inc.', title: 'Senior "Data" Engineer', url: 'http://a',
      source: 'greenhouse', score: 90, tier: 'Priority', sponsorship: 'Confirmed', location: 'Remote - US',
      status: 'ready_for_submit', application_packet_path: '/p.json', resume_pdf_path: '/r.pdf',
      matched_keywords: ['azure', 'pyspark'], missing_keywords: ['kafka'], created_at: TODAY });
  });
  afterEach(() => db.close());

  it('setJobNote persists a note and rejects unknown ids', () => {
    const r = setJobNote(db, 'j1', 'Referral from Sam');
    expect(r.notes).toBe('Referral from Sam');
    expect(db.getJob('j1').notes).toBe('Referral from Sam');
    expect(() => setJobNote(db, 'ghost', 'x')).toThrow(/unknown job/);
  });

  it('buildExportRows includes score, grade, status, blockers, notes', () => {
    setJobNote(db, 'j1', 'note A');
    const rows = buildExportRows(db, { now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      company: 'Acme, Inc.', grade: 'A', fit: 'strong', appStatus: 'ready_for_submit',
      resumeStatus: 'tailored', remote: 'yes', notes: 'note A',
    });
    expect(rows[0].matched).toBe('azure; pyspark');
  });

  it('exportRowsToCsv escapes commas/quotes and has a header row', () => {
    const csv = exportRowsToCsv(buildExportRows(db, { now: NOW }));
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toContain('Company,Role');
    // Company with a comma and title with quotes must be quoted/escaped.
    expect(lines[1]).toContain('"Acme, Inc."');
    expect(lines[1]).toContain('"Senior ""Data"" Engineer"');
  });

  it('exportRowsToCsv returns just a header when there are no rows', () => {
    expect(exportRowsToCsv([]).trim().startsWith('Company,Role')).toBe(true);
  });
});

describe('submission records and reports', () => {
  let db;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({
      id: 'r1', company: 'Acme', title: 'Sr DE', url: 'http://a', source: 'greenhouse',
      score: 90, tier: 'Priority', sponsorship: 'Confirmed', status: 'ready_for_submit',
      application_packet_path: '/p/r1.json', notes: 'called recruiter',
    });
    db.upsertJob({
      id: 'r2', company: 'Globex', title: 'DE', url: 'http://b', source: 'ashby',
      score: 70, tier: 'Queue', sponsorship: 'Likely', status: 'assist_blocked',
      assist_blockers: ['captcha detected'],
    });
    db.upsertJob({
      id: 'r3', company: 'Initech', title: 'BI Eng', url: 'http://c', source: 'lever',
      score: 80, tier: 'Apply', status: 'skipped',
    });
  });
  afterEach(() => db.close());

  it('markSubmittedByHuman records confirmation number and appends a note', () => {
    const NOW2 = new Date('2026-06-05T10:00:00Z');
    const r = markSubmittedByHuman(db, 'r1', {
      confirmationNumber: ' REQ-777 ', note: 'via Workday', now: NOW2,
    });
    expect(r.confirmationNumber).toBe('REQ-777');
    const job = db.getJob('r1');
    expect(job.submitted_confirmation).toBe('REQ-777');
    // Existing notes are preserved; the submission note is appended with a stamp.
    expect(job.notes).toContain('called recruiter');
    expect(job.notes).toContain('[submitted 2026-06-05 10:00] via Workday');
    expect(Number(job.applied)).toBe(1);
  });

  it('markSubmittedByHuman without details still works (both optional)', () => {
    const r = markSubmittedByHuman(db, 'r3', {});
    expect(r.confirmationNumber).toBeNull();
    expect(db.getJob('r3').notes ?? '').not.toContain('[submitted');
  });

  it('buildReports assembles every section consistently with the board', () => {
    markSubmittedByHuman(db, 'r1', { confirmationNumber: 'C-1', now: NOW });
    const rep = buildReports(db, { now: NOW });
    // Application log holds submitted + blocked + skipped, newest first.
    const statuses = rep.applicationLog.map((r) => r.appStatus);
    expect(statuses).toContain('submitted');
    expect(statuses).toContain('blocked');
    expect(statuses).toContain('skipped');
    const submitted = rep.applicationLog.find((r) => r.appStatus === 'submitted');
    expect(submitted.confirmation).toBe('C-1');
    expect(rep.blockedJobs).toHaveLength(1);
    expect(rep.blockedJobs[0].blockers).toEqual(['captcha detected']);
    expect(rep.skippedJobs).toHaveLength(1);
    expect(rep.sponsorshipSummary.find((s) => s.confidence === 'Confirmed').jobs).toBe(1);
    const gh = rep.sourcePerformance.find((s) => s.source === 'greenhouse');
    expect(gh).toMatchObject({ found: 1, strong: 1, submitted: 1, strongRate: 100 });
    expect(rep.dailySummary.daily).toHaveLength(7);
  });

  it('buildReports on an empty database returns empty-but-valid sections', () => {
    const empty = openDatabase({ path: ':memory:' });
    try {
      const rep = buildReports(empty, { now: NOW });
      expect(rep.applicationLog).toEqual([]);
      expect(rep.blockedJobs).toEqual([]);
      expect(rep.sourcePerformance).toEqual([]);
      expect(rep.dailySummary.totals.jobsTracked).toBe(0);
    } finally { empty.close(); }
  });

  it('listBoardJobs filters by ATS platform and resume status', () => {
    db.upsertJob({ id: 'r1', ats_platform: 'greenhouse', resume_docx_path: '/r/r1.docx' });
    db.upsertJob({ id: 'r2', ats_platform: 'workday' });
    expect(listBoardJobs(db, { now: NOW, ats: 'greenhouse' }).map((r) => r.id)).toEqual(['r1']);
    expect(listBoardJobs(db, { now: NOW, resumeStatus: 'tailored' }).map((r) => r.id)).toEqual(['r1']);
    expect(listBoardJobs(db, { now: NOW, resumeStatus: 'none' }).map((r) => r.id))
      .toEqual(expect.arrayContaining(['r2', 'r3']));
  });
});
