import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDatabase } from '../../src/logging/db.js';
import {
  deriveAppStatus, fitBucket, dashboardStats, listBoardJobs, jobDetail,
  applyDecision, approveJobPacket, rejectJobPacket, markSubmittedByHuman,
  APP_STATUS,
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
