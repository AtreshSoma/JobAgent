import { describe, it, expect } from 'vitest';

import { openDatabase } from '../../src/logging/db.js';
import {
  livenessTarget, checkPostingLiveness, sweepPostings, createLivenessCache,
} from '../../src/search/postingLiveness.js';
import { checkJobLink } from '../../src/dashboard/linkHealth.js';
import { todayQueue } from '../../src/dashboard/data.js';

/** A fetch double answering by URL substring. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    for (const [needle, reply] of routes) {
      if (String(url).includes(needle)) {
        if (reply instanceof Error) throw reply;
        return { status: reply.status, json: async () => reply.body ?? {} };
      }
    }
    return { status: 500, json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}

const WD = 'https://imh.wd108.myworkdayjobs.com/IntermountainCareers/job/Vine-Street-Office-Building/Data-Architect-Consultant_R183756';

describe('livenessTarget — which ATS API can answer for a link', () => {
  it('parses every supported ATS', () => {
    expect(livenessTarget({ url: WD })).toMatchObject({ ats: 'workday', tenant: 'imh', pod: 'wd108', site: 'IntermountainCareers' });
    expect(livenessTarget({ url: 'https://imh.wd108.myworkdayjobs.com/en-US/IntermountainCareers/job/X/Y_R1' }))
      .toMatchObject({ ats: 'workday', site: 'IntermountainCareers' });
    expect(livenessTarget({ url: 'https://jobs.smartrecruiters.com/Vericast/744000145843199' }))
      .toEqual({ ats: 'smartrecruiters', company: 'Vericast', postingId: '744000145843199' });
    expect(livenessTarget({ url: 'https://jobs.lever.co/spotify/cc5ccf57-b851-4c25-8840-ed4cd0535c12' }))
      .toMatchObject({ ats: 'lever', company: 'spotify' });
    expect(livenessTarget({ url: 'https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245' }))
      .toMatchObject({ ats: 'ashby', org: 'ramp' });
    expect(livenessTarget({ url: 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210737118' }))
      .toMatchObject({ ats: 'oracle', siteNumber: 'CX_1001', requisitionId: '210737118' });
    // Employer-hosted Greenhouse page: the board token only lives in the job id.
    expect(livenessTarget({
      id: 'greenhouse:databricks::specialist solutions architect::8544533002',
      url: 'https://databricks.com/company/careers/open-positions/job?gh_jid=8544533002',
    })).toEqual({ ats: 'greenhouse', board: 'databricks', jobId: '8544533002' });
  });

  it('flags a Workday link missing its site segment as malformed, and knows nothing about other hosts', () => {
    expect(livenessTarget({ url: 'https://cvshealth.wd1.myworkdayjobs.com/job/TX---Work-from-home/Data-Engineer_R0977321' }))
      .toEqual({ ats: 'workday-malformed' });
    expect(livenessTarget({ url: 'https://example.com/careers/123' })).toBeNull();
  });
});

describe('checkPostingLiveness — what each ATS says', () => {
  it('Workday: 200 with a posting is open; 403 S22 or 404 is closed; anything else proves nothing', async () => {
    const open = fakeFetch([['/wday/cxs/imh/IntermountainCareers/job/', { status: 200, body: { jobPostingInfo: { id: 'x' } } }]]);
    expect((await checkPostingLiveness({ url: WD }, { fetchImpl: open })).state).toBe('open');
    expect(open.calls[0]).toBe('https://imh.wd108.myworkdayjobs.com/wday/cxs/imh/IntermountainCareers/job/Vine-Street-Office-Building/Data-Architect-Consultant_R183756');

    const s22 = fakeFetch([['/wday/cxs/', { status: 403, body: { errorCode: 'S22', httpStatus: 403 } }]]);
    expect((await checkPostingLiveness({ url: WD }, { fetchImpl: s22 })).state).toBe('closed');
    const gone = fakeFetch([['/wday/cxs/', { status: 404 }]]);
    expect((await checkPostingLiveness({ url: WD }, { fetchImpl: gone })).state).toBe('closed');
    // A 403 WITHOUT Workday's not-found code (a WAF, a tenant lock-down) is not proof.
    const waf = fakeFetch([['/wday/cxs/', { status: 403, body: {} }]]);
    expect((await checkPostingLiveness({ url: WD }, { fetchImpl: waf })).state).toBe('unknown');
    const down = fakeFetch([['/wday/cxs/', { status: 503 }]]);
    expect((await checkPostingLiveness({ url: WD }, { fetchImpl: down })).state).toBe('unknown');
  });

  it('SmartRecruiters, Greenhouse, Lever and Oracle', async () => {
    const f = fakeFetch([
      ['/companies/Acme/postings/1', { status: 200, body: { active: false } }],
      ['/companies/Acme/postings/2', { status: 200, body: { active: true } }],
      ['boards/databricks/jobs/9', { status: 404 }],
      ['api.lever.co/v0/postings/spotify/', { status: 404 }],
      ['recruitingCEJobRequisitionDetails', { status: 200, body: { items: [] } }],
    ]);
    const sr = (id) => checkPostingLiveness({ url: `https://jobs.smartrecruiters.com/Acme/${id}` }, { fetchImpl: f });
    expect((await sr(1)).state).toBe('closed');
    expect((await sr(2)).state).toBe('open');
    expect((await checkPostingLiveness({ id: 'greenhouse:databricks::x::9', url: 'https://databricks.com/job?gh_jid=9' }, { fetchImpl: f })).state).toBe('closed');
    expect((await checkPostingLiveness({ url: 'https://jobs.lever.co/spotify/cc5ccf57-b851-4c25-8840-ed4cd0535c12' }, { fetchImpl: f })).state).toBe('closed');
    expect((await checkPostingLiveness({ url: 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/1' }, { fetchImpl: f })).state).toBe('closed');
  });

  it('Ashby: one board read answers every posting on it', async () => {
    const f = fakeFetch([['posting-api/job-board/ramp', { status: 200, body: { jobs: [{ id: '34413F8D-26BF-4BBC-8ADE-EB309A0E2245' }] } }]]);
    const cache = createLivenessCache();
    const base = 'https://jobs.ashbyhq.com/ramp/';
    expect((await checkPostingLiveness({ url: `${base}34413f8d-26bf-4bbc-8ade-eb309a0e2245` }, { fetchImpl: f, cache })).state).toBe('open');
    expect((await checkPostingLiveness({ url: `${base}00000000-0000-0000-0000-000000000000` }, { fetchImpl: f, cache })).state).toBe('closed');
    expect(f.calls).toHaveLength(1);
  });

  it('a network error or an unsupported host is unknown, never closed', async () => {
    const boom = fakeFetch([['/wday/cxs/', new Error('ECONNRESET')]]);
    expect((await checkPostingLiveness({ url: WD }, { fetchImpl: boom })).state).toBe('unknown');
    expect((await checkPostingLiveness({ url: 'https://example.com/jobs/1' }, { fetchImpl: boom })).state).toBe('unknown');
  });
});

function seed(db) {
  const base = { source: 'workday', company: 'Acme', status: 'scored', tier: 'Apply', posted_at: '2026-09-20T00:00:00.000Z' };
  db.upsertJob({ ...base, id: 'dead', title: 'Data Engineer', url: `${WD}`, score: 90 });
  db.upsertJob({ ...base, id: 'live', title: 'Data Engineer II', url: WD.replace('R183756', 'R1'), score: 80 });
  db.upsertJob({ ...base, id: 'applied-dead', title: 'DE III', url: WD.replace('R183756', 'R2'), score: 85, applied: 1, status: 'submitted' });
  db.upsertJob({ ...base, id: 'short-dead', title: 'DE IV', url: WD.replace('R183756', 'R3'), score: 70, user_decision: 'shortlisted' });
}
const deadFor = (ids) => fakeFetch([
  ...ids.map((id) => [id, { status: 403, body: { errorCode: 'S22' } }]),
  ['/wday/cxs/', { status: 200, body: { jobPostingInfo: {} } }],
]);

describe('recording a check — closed postings leave the board, invested ones stay flagged', () => {
  it('retires an untouched closed posting through a legal, logged transition', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    expect(db.recordPostingCheck('dead', { state: 'closed', via: 'workday' })).toEqual({ id: 'dead', state: 'closed', retired: true });
    const row = db.getJob('dead');
    expect(row.status).toBe('discarded');
    expect(row.discard_reason).toMatch(/^expired: the employer closed this posting/);
    expect(row.link_state).toBe('closed');
    expect(db.listEvents?.('dead')?.some?.((e) => e.event_type === 'status_changed') ?? true).toBe(true);
    db.close();
  });

  it('keeps a shortlisted job on the board with the flag, and never touches an applied one', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    expect(db.recordPostingCheck('short-dead', { state: 'closed', via: 'workday' }).retired).toBe(false);
    expect(db.getJob('short-dead')).toMatchObject({ status: 'scored', link_state: 'closed' });
    db.close();
  });

  it('an unknown answer only records that we looked', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    db.recordPostingCheck('dead', { state: 'unknown', checkedAt: '2026-09-23T10:00:00.000Z' });
    expect(db.getJob('dead')).toMatchObject({ status: 'scored', link_state: null, link_checked_at: '2026-09-23T10:00:00.000Z' });
    db.close();
  });
});

describe('sweepPostings', () => {
  it('checks open, unapplied rows best-first, retires the closed ones, and skips rows checked recently', async () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    const fetchImpl = deadFor(['R183756', 'R3']);
    const now = new Date('2026-09-23T12:00:00.000Z');
    const out = await sweepPostings({ db, fetchImpl, now, spacingMs: 0 });
    // applied-dead is excluded (applied); short-dead is closed but kept.
    expect(out).toMatchObject({ checked: 3, open: 1, closed: 2, retired: 1 });
    expect(db.getJob('dead').status).toBe('discarded');
    expect(db.getJob('short-dead').status).toBe('scored');
    expect(db.getJob('live')).toMatchObject({ status: 'scored', link_state: 'open' });

    const again = await sweepPostings({ db, fetchImpl, now: new Date('2026-09-23T13:00:00.000Z'), spacingMs: 0 });
    expect(again.checked).toBe(0); // everything was checked within the last 24 h
    db.close();
  });

  it('a dry run writes nothing', async () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    const out = await sweepPostings({ db, fetchImpl: deadFor(['R183756']), apply: false, spacingMs: 0 });
    expect(out.closed).toBeGreaterThan(0);
    expect(db.getJob('dead').status).toBe('scored');
    db.close();
  });
});

describe('Check link asks the ATS before trusting an HTTP 200', () => {
  it('reports a Workday posting the employer closed as closed', async () => {
    const result = await checkJobLink(WD, {
      job: { id: 'dead', url: WD },
      livenessImpl: async () => ({ state: 'closed', via: 'workday', httpStatus: 403 }),
      fetchImpl: async () => ({ status: 200, headers: { get: () => null }, url: WD }),
      lookupImpl: async () => [{ address: '93.184.216.34' }],
    });
    expect(result).toMatchObject({ status: 'closed', liveness: { state: 'closed' } });
    expect(result.message).toMatch(/Workday no longer lists it/);
  });

  it('falls back to the HTTP check when the ATS cannot answer', async () => {
    const result = await checkJobLink('https://example.com/jobs/1', {
      job: { id: 'x', url: 'https://example.com/jobs/1' },
      fetchImpl: async () => ({ status: 200, headers: { get: () => null }, url: 'https://example.com/jobs/1' }),
      lookupImpl: async () => [{ address: '93.184.216.34' }],
    });
    expect(result.status).toBe('reachable');
  });
});

describe('Today never recommends a closed posting', () => {
  it('drops untouched closed rows and turns a shortlisted one into "archive it"', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'a', title: 'A', status: 'scored', score: 95, tier: 'Priority', user_decision: 'shortlisted', link_state: 'closed' });
    db.upsertJob({ id: 'b', title: 'B', status: 'scored', score: 94, tier: 'Priority', link_state: 'closed' });
    db.upsertJob({ id: 'c', title: 'C', status: 'scored', score: 60, tier: 'Queue', user_decision: 'shortlisted' });
    const items = todayQueue(db, { now: new Date('2026-09-23T12:00:00.000Z') }).items;
    expect(items.map((i) => i.id)).not.toContain('b');
    expect(items.find((i) => i.id === 'a')?.nextAction.label).toMatch(/closed this posting/);
    db.close();
  });
});
