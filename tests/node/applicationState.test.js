import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  APPLICATION_PHASE,
  applicationStatePath,
  applicationStatePreventsReopen,
  createApplicationState,
  createFileApplicationStateStore,
  markApplicationUserSubmitted,
  markApplicationVerified,
  transitionApplicationState,
  validateApplicationState,
} from '../../src/apply/applicationState.js';

const PACKET = {
  id: 'packet-1',
  job: {
    id: 'job/one',
    url: 'https://jobs.example.test/apply?id=42&access_token=do-not-persist',
  },
  ats: { platform: 'generic' },
};

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable application state', () => {
  it('persists the workflow checkpoint without field values, answers, or absolute document paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'application-state-'));
    dirs.push(root);
    const path = applicationStatePath(root, PACKET);
    const store = createFileApplicationStateStore(path);
    let state = createApplicationState(PACKET, { now: new Date('2026-07-11T10:00:00Z') });
    state = transitionApplicationState(state, APPLICATION_PHASE.FILLING, {
      currentStep: 2,
      lastUrl: 'https://jobs.example.test/apply/step/2?session=secret',
      completedFields: [{ field: 'email', label: 'Email', value: 'private@example.test', source: 'profile' }],
      unresolvedQuestions: [{ label: 'Salary expectation', answer: '$123,456', required: true }],
      uploadVerification: [{ type: 'resume', path: 'C:\\private\\Candidate_Name_Resume.pdf', verified: true }],
      blockers: ['Salary expectation needs user input'],
    }, { now: new Date('2026-07-11T10:01:00Z') });
    store.save(state);

    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('private@example.test');
    expect(raw).not.toContain('$123,456');
    expect(raw).not.toContain('C:\\private');
    expect(raw).not.toContain('access_token');
    expect(raw).not.toContain('session=secret');

    const loaded = store.load();
    expect(validateApplicationState(loaded)).toBe(true);
    expect(loaded.currentStep).toBe(2);
    expect(loaded.completedFields[0]).toMatchObject({ field: 'email', label: 'Email', step: 2 });
    expect(loaded.uploadVerification[0]).toMatchObject({ type: 'resume', fileName: 'Candidate_Name_Resume.pdf', verified: true });
    expect(loaded.phaseTimestamps.filling.firstAt).toBe('2026-07-11T10:01:00.000Z');
    expect(readdirSync(join(root, 'data', 'application-state')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('requires explicit evidence for User Submitted -> Verified and prevents reopening both states', async () => {
    const root = mkdtempSync(join(tmpdir(), 'application-state-'));
    dirs.push(root);
    const path = applicationStatePath(root, PACKET);
    const store = createFileApplicationStateStore(path);
    store.save(createApplicationState(PACKET));

    const submitted = await markApplicationUserSubmitted({ store, packet: PACKET, evidence: ['human clicked Submit'] });
    expect(submitted.phase).toBe(APPLICATION_PHASE.USER_SUBMITTED);
    expect(applicationStatePreventsReopen(submitted)).toBe(true);
    await expect(markApplicationVerified({ store, packet: PACKET })).rejects.toThrow(/evidence is required/);

    const verified = await markApplicationVerified({ store, packet: PACKET, evidence: ['ATS confirmation email received'] });
    expect(verified.phase).toBe(APPLICATION_PHASE.VERIFIED);
    expect(verified.verificationEvidence).toEqual(['ATS confirmation email received']);
    expect(applicationStatePreventsReopen(verified)).toBe(true);
    expect(() => transitionApplicationState(verified, APPLICATION_PHASE.OPENING)).toThrow(/cannot transition/);
  });

  it('rejects a malformed checkpoint instead of silently starting over', () => {
    const root = mkdtempSync(join(tmpdir(), 'application-state-'));
    dirs.push(root);
    const path = join(root, 'bad.json');
    const store = createFileApplicationStateStore(path);
    expect(() => store.save({ schemaVersion: 1, phase: 'made_up' })).toThrow(/invalid application state phase/);
  });
});
