import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase } from '../../src/logging/db.js';
import { reconcileStalePackets } from '../../src/apply/packetHygiene.js';
import { todayQueue } from '../../src/dashboard/data.js';
import { workHistoryIn, educationIn, buildBackground } from '../../src/profile/fromResume.js';
import { splitSections } from '../../src/resume/resumeProfile.js';
import { refreshBackgroundFromResume, saveProfile } from '../../src/profile/store.js';
import { canTransition, LIFECYCLE } from '../../src/lifecycle.js';

const NOW = new Date('2026-09-23T15:00:00.000Z');
const ME = { candidate: { identity: { fullName: 'Priya Raghunathan' } } };

/** Seed the 2026-09-23 shape: approved packets built for the template profile. */
function seedStale(db, { id = 'j1', status = 'failed', packet = '/x/p.json' } = {}) {
  db.upsertJob({
    id, title: 'Data Engineer', company: 'Acme', status, score: 75, tier: 'Apply',
    application_packet_path: packet, resume_docx_path: '/x/Jane_Doe_Resume.docx',
    assist_blockers: ['could not start browser: Executable doesn\'t exist'],
  });
  db.insertApproval({ id: `ap-${id}`, job_id: id, packet_path: packet, approval_status: 'approved' });
}
const templatePacket = () => ({
  documents: { resumeDocx: '/x/Jane_Doe_Resume_Data_Engineer.docx', coverLetter: null },
  candidateName: undefined,
});

describe('reconcileStalePackets — no approved packet survives that can only be refused', () => {
  it('withdraws a packet built for another profile and returns the job to "prepare", shortlisted', () => {
    const db = openDatabase({ path: ':memory:' });
    seedStale(db);
    const out = reconcileStalePackets({ db, config: ME, loadPacketImpl: templatePacket });
    expect(out.superseded.map((s) => s.jobId)).toEqual(['j1']);
    expect(out.superseded[0].reason).toMatch(/another profile/);
    const job = db.getJob('j1');
    expect(job).toMatchObject({ status: 'queued', user_decision: 'shortlisted', application_packet_path: null, resume_docx_path: null, assist_blockers: null });
    expect(db.getApprovalByJob('j1')).toBeUndefined();
    expect(db.listEvents?.('j1')?.some?.((e) => e.event_type === 'packet_superseded') ?? true).toBe(true);
    db.close();
  });

  it('treats a missing packet file the same way', () => {
    const db = openDatabase({ path: ':memory:' });
    seedStale(db);
    expect(reconcileStalePackets({ db, config: ME, loadPacketImpl: () => null }).superseded[0].reason).toMatch(/missing/);
    db.close();
  });

  it('never touches a submission or a form the human may be finishing, and a dry run writes nothing', () => {
    const db = openDatabase({ path: ':memory:' });
    seedStale(db, { id: 'ready', status: 'ready_for_submit' });
    seedStale(db, { id: 'mine' });
    const dry = reconcileStalePackets({ db, config: ME, loadPacketImpl: templatePacket, apply: false });
    expect(dry.superseded.map((s) => s.jobId)).toEqual(['mine']);
    expect(db.getJob('mine').status).toBe('failed');
    reconcileStalePackets({ db, config: ME, loadPacketImpl: templatePacket });
    expect(db.getJob('ready').status).toBe('ready_for_submit');
    expect(db.getApprovalByJob('ready')).toBeTruthy();
    db.close();
  });

  it('the moves it makes are legal lifecycle transitions', () => {
    for (const from of [LIFECYCLE.PREPARED, LIFECYCLE.FAILED, LIFECYCLE.ASSIST_BLOCKED, LIFECYCLE.CANCELLED]) {
      expect(canTransition(from, LIFECYCLE.QUEUED)).toBe(true);
      expect(canTransition(from, LIFECYCLE.DISCARDED)).toBe(true);
    }
  });
});

describe('a closed posting with an unsubmitted packet is retired, not offered as a retry', () => {
  it('recordPostingCheck retires it and withdraws the packet', () => {
    const db = openDatabase({ path: ':memory:' });
    seedStale(db);
    expect(db.recordPostingCheck('j1', { state: 'closed', via: 'greenhouse' })).toMatchObject({ retired: true });
    expect(db.getJob('j1')).toMatchObject({ status: 'discarded', link_state: 'closed' });
    expect(db.getJob('j1').discard_reason).toMatch(/^expired: the employer closed this posting/);
    expect(db.getApprovalByJob('j1')).toBeUndefined();
    db.close();
  });

  it('the posting check now looks at packet and failed rows, not only scored ones', () => {
    const db = openDatabase({ path: ':memory:' });
    seedStale(db);
    expect(db.listPostingsToCheck({ olderThan: NOW.toISOString() }).map((r) => r.id)).toContain('j1');
    db.close();
  });
});

describe('Today: a closed posting is checked before anything else', () => {
  it('offers "Archive" — never "Retry auto-fill" — for a closed job whose last fill also lacked a browser', () => {
    const db = openDatabase({ path: ':memory:' });
    seedStale(db);
    db.upsertJob({ id: 'j1', link_state: 'closed' });
    const item = todayQueue(db, { now: NOW, browserAvailable: true }).items.find((i) => i.id === 'j1');
    expect(item?.nextAction).toEqual({ kind: 'archive', label: 'Archive — the posting is closed' });
    db.close();
  });

  it('a recovered browser failure is a short "Retry auto-fill" button', () => {
    const db = openDatabase({ path: ':memory:' });
    seedStale(db);
    const item = todayQueue(db, { now: NOW, browserAvailable: true }).items.find((i) => i.id === 'j1');
    expect(item?.nextAction.label).toBe('Retry auto-fill');
    db.close();
  });
});

const RESUME = [
  'Priya Raghunathan',
  'priya@example.com | Austin, TX',
  'PROFESSIONAL EXPERIENCE',
  'Senior Data Engineer, Platform Team | Globex Corporation (Contract)',
  'Austin, TX (Remote) | April 2022 - Present',
  'Platform serving 40 analytics teams across the company.',
  'Architected a lakehouse on Databricks and Delta Lake serving 40 analytics teams.',
  'Engineered streaming ingestion with Kafka that cut data latency from hours to minutes.',
  'Data Engineer | Initech',
  'Dallas, TX | June 2019 - March 2022',
  'Built dbt models and Airflow DAGs for a 20 TB Snowflake warehouse used by finance.',
  'EDUCATION',
  'University of Texas at Austin | Master of Science in Computer Science | 2019',
];

describe('workHistoryIn — roles read verbatim from the resume', () => {
  it('reads employer, title, place, dates and achievement bullets, skipping context lines', () => {
    const roles = workHistoryIn(splitSections(RESUME));
    expect(roles).toEqual([
      {
        employer: 'Globex Corporation', title: 'Senior Data Engineer', location: 'Austin, TX (Remote)',
        startDate: 'April 2022', endDate: '', current: true,
        highlights: [
          'Architected a lakehouse on Databricks and Delta Lake serving 40 analytics teams.',
          'Engineered streaming ingestion with Kafka that cut data latency from hours to minutes.',
        ],
      },
      {
        employer: 'Initech', title: 'Data Engineer', location: 'Dallas, TX',
        startDate: 'June 2019', endDate: 'March 2022', current: false,
        highlights: ['Built dbt models and Airflow DAGs for a 20 TB Snowflake warehouse used by finance.'],
      },
    ]);
  });

  it('splits "Master of Science in Computer Science" into degree and field', () => {
    expect(educationIn(splitSections(RESUME))[0]).toMatchObject({
      institution: 'University of Texas at Austin', degree: 'Master of Science', field: 'Computer Science', graduationYear: '2019',
    });
  });

  it('buildBackground now carries the work history', () => {
    expect(buildBackground(RESUME).workHistory).toHaveLength(2);
  });
});

describe('refreshBackgroundFromResume — replaces the template background, never the search goals', () => {
  function workspace(name = 'Priya Raghunathan') {
    const root = mkdtempSync(join(tmpdir(), 'ja-refresh-'));
    mkdirSync(join(root, 'config'), { recursive: true });
    mkdirSync(join(root, 'resumes', 'base'), { recursive: true });
    writeFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'), 'stub');
    for (const f of ['scoring.json', 'exclusions.json', 'role_families.json', 'screening_answers.json', 'cover_letter.json', 'jobboards.json']) {
      try { writeFileSync(join(root, 'config', f), readFileSync(join(process.env.JOB_AGENT_ROOT ?? '.', 'config', f))); } catch { /* optional */ }
    }
    saveProfile(root, {
      id: 'me', label: 'Me', identity: { fullName: name },
      background: {
        currentRoles: ['Senior Data Engineer'],
        workHistory: [{ employer: 'Example Corp', title: 'Senior Data Engineer', highlights: ['One-line, metric-backed achievement bullet'] }],
        education: [{ institution: 'Example University', degree: 'Master of Science' }],
        skills: [],
      },
      searchIntent: { targetRoles: ['Staff Data Engineer'], locations: ['United States'] },
    });
    writeFileSync(join(root, 'config', 'profiles', '_active.json'), JSON.stringify({ id: 'me' }));
    return root;
  }
  const extractDocxText = () => ({ paragraphs: RESUME });

  it('fills work history and education from the resume and leaves target roles alone', async () => {
    const root = workspace();
    try {
      const result = await refreshBackgroundFromResume(root, join(root, 'resumes', 'base', 'MASTER_RESUME.docx'), { extractDocxText });
      expect(result.ok).toBe(true);
      expect(result.changed).toEqual(expect.arrayContaining(['workHistory', 'education']));
      const saved = JSON.parse(readFileSync(join(root, 'config', 'profiles', 'me.json'), 'utf8'));
      expect(saved.background.workHistory[0].employer).toBe('Globex Corporation');
      expect(saved.background.education[0].institution).toBe('University of Texas at Austin');
      expect(JSON.stringify(saved.background)).not.toMatch(/Example Corp|Example University|metric-backed achievement/);
      expect(saved.searchIntent.targetRoles).toEqual(['Staff Data Engineer']);
      // Synced FROM this resume, so the "resume has moved on" prompt is answered.
      expect(saved.acknowledgedResume).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a resume that names a different person', async () => {
    const root = workspace('Somebody Else');
    try {
      const result = await refreshBackgroundFromResume(root, join(root, 'resumes', 'base', 'MASTER_RESUME.docx'), { extractDocxText });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/names Priya Raghunathan/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Today reasons never just repeat the status chip', () => {
  it('says what is waiting for a packet to review and for a shortlisted job', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'r', title: 'R', company: 'A', status: 'prepared', score: 80, tier: 'Apply', application_packet_path: '/x/p.json' });
    db.insertApproval({ id: 'ap-r', job_id: 'r', packet_path: '/x/p.json', approval_status: 'pending_review' });
    db.upsertJob({ id: 's', title: 'S', company: 'B', status: 'queued', score: 70, tier: 'Queue', user_decision: 'shortlisted' });
    const items = todayQueue(db, { now: NOW }).items;
    const reasonOf = (id) => items.find((i) => i.id === id)?.reason;
    expect(reasonOf('r')).toMatch(/tailored resume and cover letter are ready/);
    expect(reasonOf('s')).toMatch(/not prepared yet/);
    for (const item of items) expect(item.reason.toLowerCase()).not.toBe(String(item.statusLabel).toLowerCase());
    db.close();
  });
});

describe('years of experience: the candidate\'s own stated number wins', () => {
  it('reads "with 10+ years designing …" from the summary, but never a number inside a bullet', async () => {
    const { yearsOfExperience } = await import('../../src/profile/fromResume.js');
    const summary = ['Priya Raghunathan', 'SUMMARY', 'Senior Data Engineer with 10+ years designing enterprise data platforms.',
      'EXPERIENCE', 'Data Engineer | Acme', 'Austin | 2019 - Present'];
    expect(yearsOfExperience(summary.join('\n'), splitSections(summary), NOW)).toBe(10);
    const bullet = ['EXPERIENCE', 'Data Engineer | Acme', 'Austin | 2019 - Present', 'Migrated a team with 5 years of history onto Snowflake.'];
    expect(yearsOfExperience(bullet.join('\n'), splitSections(bullet), NOW)).not.toBe(5);
  });
});
