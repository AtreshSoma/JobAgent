import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildExtensionPayload, isChromiumExtensionOrigin, readApprovedArtifact, validExtensionKey,
} from '../../src/extension/companion.js';

const packet = (root) => ({
  job: { id: 'j1', company: 'Acme', title: 'Data Engineer', url: 'https://acme.test/apply' },
  ats: { platform: 'greenhouse' }, blockers: [], resumePath: join(root, 'resume.docx'),
});

function fixture(root, approval = {}) {
  const row = { job_id: 'j1', approval_status: 'approved', approved_by_user: 1, ...approval };
  return {
    jobId: 'j1',
    db: {
      getApprovalByJob: () => row,
      getJob: () => ({ id: 'j1', url: 'https://acme.test/apply', applied: 0, status: 'prepared' }),
    },
    config: {
      root,
      candidate: { identity: { fullName: 'Ada Lovelace', links: { linkedin: 'https://linkedin.test/ada' } }, contact: { email: 'ada@test' } },
      screeningAnswers: { answers: [{ id: 'auth', patterns: ['authorized'], answer: 'Yes', type: 'text' }] },
    },
    loadPacketImpl: () => packet(root),
  };
}

describe('extension companion security boundary', () => {
  it('accepts only Chromium extension origins and constant-time sized keys', () => {
    expect(isChromiumExtensionOrigin(`chrome-extension://${'a'.repeat(32)}`)).toBe(true);
    expect(isChromiumExtensionOrigin(`extension://${'b'.repeat(32)}`)).toBe(true);
    expect(isChromiumExtensionOrigin(`extension://${'b'.repeat(32)}/`)).toBe(true);
    expect(isChromiumExtensionOrigin('https://evil.test')).toBe(false);
    expect(isChromiumExtensionOrigin('extension://not-a-valid-extension-id')).toBe(false);
    expect(validExtensionKey('x'.repeat(32), 'x'.repeat(32))).toBe(true);
    expect(validExtensionKey('x'.repeat(32), 'y'.repeat(32))).toBe(false);
    expect(validExtensionKey('short', 'short')).toBe(false);
  });

  it('returns a minimized payload only for an explicitly approved packet', () => {
    const root = mkdtempSync(join(tmpdir(), 'extension-'));
    try {
      const args = fixture(root);
      const payload = buildExtensionPayload(args);
      expect(payload.approval).toEqual({ approved: true, stopBeforeSubmit: true });
      expect(payload.profile.contact.email).toBe('ada@test');
      expect(payload.artifacts.resume.name).toBe('resume.docx');
      expect(payload).not.toHaveProperty('resumePath');
      expect(() => buildExtensionPayload(fixture(root, { approval_status: 'pending_review', approved_by_user: 0 }))).toThrow(/approved/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('serves only packet artifacts confined to the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'extension-'));
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    try {
      writeFileSync(join(root, 'resume.docx'), 'approved bytes');
      const artifact = readApprovedArtifact({ ...fixture(root), kind: 'resume' });
      expect(artifact.bytes.toString()).toBe('approved bytes');
      const escaped = fixture(root);
      escaped.loadPacketImpl = () => ({ ...packet(root), resumePath: join(outside, 'resume.docx') });
      writeFileSync(join(outside, 'resume.docx'), 'nope');
      expect(() => readApprovedArtifact({ ...escaped, kind: 'resume' })).toThrow(/escapes/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('blocks duplicate application access after submission', () => {
    const root = mkdtempSync(join(tmpdir(), 'extension-'));
    try {
      const args = fixture(root);
      args.db.getJob = () => ({ id: 'j1', applied: 1, status: 'submitted' });
      expect(() => buildExtensionPayload(args)).toThrow(/already submitted/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
