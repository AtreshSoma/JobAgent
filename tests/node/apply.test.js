import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase } from '../../src/logging/db.js';
import { answerScreeningQuestion } from '../../src/apply/screeningQA.js';
import { detectAts, KNOWN_PLATFORMS } from '../../src/apply/atsDetector.js';
import { buildPrefillPlan, classifyLabel, valueForField } from '../../src/apply/formPrefill.js';
import { buildUploadPlan } from '../../src/apply/fileUpload.js';
import { getPlatform, PLATFORMS } from '../../src/apply/platforms/index.js';
import { buildApplicationPacket, writePacket } from '../../src/apply/applicationPacket.js';
import {
  enqueueForApproval, listPending, approve, reject, isClearedForAssist, APPROVAL_STATUS,
} from '../../src/apply/approvalQueue.js';
import { loadConfig } from '../../src/config/loadConfig.js';

const { candidate, screeningAnswers } = loadConfig({ loadEnv: false, env: {} });

describe('screeningQA', () => {
  it('answers a matched question from config', () => {
    const r = answerScreeningQuestion('How many years of experience do you have?', screeningAnswers);
    expect(r.answered).toBe(true);
    expect(r.answer).toBe('10+ years');
  });

  it('answers sponsorship truthfully (never "no sponsorship required")', () => {
    const r = answerScreeningQuestion('Will you now or in the future require sponsorship?', screeningAnswers);
    expect(r.answered).toBe(true);
    expect(r.answer.toLowerCase()).toContain('require');
    expect(r.answer.toLowerCase()).not.toContain('no sponsorship required');
  });

  it('asks the user when no pattern matches', () => {
    const r = answerScreeningQuestion('What is your favorite database color?', screeningAnswers);
    expect(r.answered).toBe(false);
    expect(r.action).toBe('ask_user');
  });

  it('maps a yes/no question to a provided choice', () => {
    const r = answerScreeningQuestion('Consent to a background check?', screeningAnswers, { choices: ['Yes', 'No'] });
    expect(r.answered).toBe(true);
    expect(r.answer).toBe('Yes');
  });
});

describe('atsDetector', () => {
  it('detects platforms by host', () => {
    expect(detectAts({ url: 'https://boards.greenhouse.io/acme/jobs/123' }).platform).toBe('greenhouse');
    expect(detectAts({ url: 'https://jobs.lever.co/acme/abc' }).platform).toBe('lever');
    expect(detectAts({ url: 'https://acme.wd1.myworkdayjobs.com/x' }).platform).toBe('workday');
  });
  it('falls back to generic for unknown hosts', () => {
    expect(detectAts({ url: 'https://careers.acme.com/job/1' }).platform).toBe('generic');
  });
  it('detects from html signals', () => {
    expect(detectAts({ url: 'https://x.com', html: '<div>powered by smartrecruiters</div>' }).platform).toBe('smartrecruiters');
  });
  it('exposes all known platforms', () => {
    expect(KNOWN_PLATFORMS).toEqual(expect.arrayContaining(Object.keys(PLATFORMS)));
  });
});

describe('formPrefill', () => {
  it('classifies labels and resolves profile values', () => {
    expect(classifyLabel('Email Address')).toBe('email');
    expect(valueForField('email', candidate)).toBe(candidate.contact.email);
  });

  it('classifies the phone number field but never phone-adjacent controls', () => {
    expect(classifyLabel('Phone Number')).toBe('phone');
    expect(classifyLabel('Mobile')).toBe('phone');
    // These each contain "phone"/"code" but are NOT the phone-number field and
    // must not be filled with the candidate phone number.
    expect(classifyLabel('Phone Extension')).toBeNull();
    expect(classifyLabel('Phone Device Type')).toBeNull();
  });

  it('does not fill a phone extension field from the phone number', () => {
    const fields = [
      { label: 'Phone Number', selector: '#phone' },
      { label: 'Phone Extension', selector: '#ext' },
    ];
    const { plan } = buildPrefillPlan(fields, { candidate, screeningAnswers });
    expect(plan.find((p) => p.selector === '#phone')?.field).toBe('phone');
    expect(plan.find((p) => p.selector === '#ext')).toBeUndefined();
  });

  it('builds a plan and flags unknown fields for the user', () => {
    const fields = [
      { label: 'First Name', selector: '#fn' },
      { label: 'Email', selector: '#em' },
      { label: 'Describe your favorite framework', selector: '#q1' },
    ];
    const { plan, needsUser, submitReady } = buildPrefillPlan(fields, { candidate, screeningAnswers });
    expect(submitReady).toBe(false);
    expect(plan.find((p) => p.field === 'email')).toBeTruthy();
    expect(needsUser.length).toBe(1);
  });
});

describe('fileUpload', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'upload-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('validates an existing resume and reports a missing file', () => {
    const resume = join(dir, 'resume.pdf');
    writeFileSync(resume, '%PDF-1.4 fake');
    const ok = buildUploadPlan({ resumePath: resume });
    expect(ok.ready).toBe(true);
    expect(ok.uploads[0].type).toBe('resume');

    const bad = buildUploadPlan({ resumePath: join(dir, 'nope.pdf') });
    expect(bad.ready).toBe(false);
    expect(bad.blockers.length).toBeGreaterThan(0);
  });

  it('rejects unsupported file types', () => {
    const resume = join(dir, 'resume.txt');
    writeFileSync(resume, 'hi');
    const r = buildUploadPlan({ resumePath: resume });
    expect(r.ready).toBe(false);
  });
});

describe('platforms', () => {
  it('every platform plan stops before submit', () => {
    for (const key of Object.keys(PLATFORMS)) {
      const plan = getPlatform(key).prepare({ prefill: { plan: [], needsUser: [] }, uploads: { uploads: [] } });
      expect(plan.submitReady).toBe(false);
      expect(plan.stopBeforeSubmit).toBe(true);
    }
  });

  it('binds prefill entries to platform selectors', () => {
    const packet = {
      prefill: { plan: [{ field: 'email', label: 'Email', value: 'a@b.com', source: 'profile' }], needsUser: [] },
      uploads: { uploads: [{ type: 'resume', path: '/x/r.pdf' }] },
    };
    const plan = getPlatform('greenhouse').prepare(packet);
    expect(plan.steps[0].selector).toBe('#email');
    expect(plan.uploads[0].selector).toContain('resume');
  });
});

describe('applicationPacket', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'packet-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('builds a packet that is never submit-ready', () => {
    const resume = join(dir, 'resume.pdf');
    writeFileSync(resume, '%PDF-1.4 fake');
    const job = { id: 'j1', company: 'Acme', title: 'Senior Data Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1', source: 'greenhouse' };
    const packet = buildApplicationPacket({
      job,
      score: { total: 88, sponsorship: 'Confirmed' },
      tier: 'Apply',
      candidate,
      screeningAnswers,
      resumePath: resume,
      formFields: [{ label: 'Email' }, { label: 'First Name' }],
    });
    expect(packet.submitReady).toBe(false);
    expect(packet.approvalStatus).toBe('pending_review');
    expect(packet.ats.platform).toBe('greenhouse');

    const path = writePacket(packet, dir);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.id).toBe(packet.id);
  });
});

describe('approvalQueue (compliance gate)', () => {
  let db;
  beforeEach(() => { db = openDatabase({ path: ':memory:' }); });
  afterEach(() => { db.close(); });

  const packet = { id: 'p1', job: { id: 'j1' } };

  it('enqueues as pending and lists it', () => {
    const { id, status } = enqueueForApproval(db, { packet, packetPath: '/tmp/p1.json' });
    expect(status).toBe(APPROVAL_STATUS.PENDING);
    expect(listPending(db).map((r) => r.id)).toContain(id);
  });

  it('de-duplicates by job: re-enqueuing updates the existing row in place', () => {
    const first = enqueueForApproval(db, { packet, packetPath: '/tmp/p1.json' });
    approve(db, first.id); // user approves the first version

    // Re-prepare the same job -> same row, repointed at the new packet, reset to pending.
    const second = enqueueForApproval(db, { packet, packetPath: '/tmp/p1-v2.json' });
    expect(second.id).toBe(first.id);
    expect(second.updated).toBe(true);

    const rows = db.listApprovals();
    expect(rows.length).toBe(1); // no duplicate
    const row = db.getApproval(first.id);
    expect(row.packet_path).toBe('/tmp/p1-v2.json');
    expect(row.approval_status).toBe(APPROVAL_STATUS.PENDING); // must be re-approved
    expect(row.approved_by_user).toBe(0);
  });

  it('clears a packet for assisted filling only after human approval', () => {
    const { id } = enqueueForApproval(db, { packet, packetPath: '/tmp/p1.json' });

    // Pending -> not cleared (no human approval yet).
    let row = db.getApproval(id);
    expect(isClearedForAssist(row).clearedForAssist).toBe(false);

    // Approved by the human -> cleared for assisted filling (never auto-submit).
    approve(db, id);
    row = db.getApproval(id);
    expect(isClearedForAssist(row).clearedForAssist).toBe(true);
  });

  it('rejection removes it from pending and never clears for assist', () => {
    const { id } = enqueueForApproval(db, { packet, packetPath: '/tmp/p1.json' });
    reject(db, id);
    expect(listPending(db).length).toBe(0);
    const row = db.getApproval(id);
    expect(isClearedForAssist(row).clearedForAssist).toBe(false);
  });
});
