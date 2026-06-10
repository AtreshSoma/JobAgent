import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { keywordsForJob, masterResumePath, tailorResumeForJob } from '../../src/resume/tailorRunner.js';

describe('keywordsForJob', () => {
  it('de-dupes matched + missing keywords, matched first', () => {
    const kws = keywordsForJob({
      matchedKeywords: ['Spark', 'Airflow'],
      missingKeywords: ['airflow', 'dbt'],
    });
    expect(kws).toEqual(['Spark', 'Airflow', 'dbt']);
  });
});

describe('tailorResumeForJob', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tailor-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('falls back gracefully (no spawn) when the master resume is missing', async () => {
    let spawned = false;
    const r = await tailorResumeForJob({
      job: { company: 'Acme', title: 'SDE', jdText: 'spark airflow' },
      score: { matchedKeywords: ['spark'], missingKeywords: [] },
      config: { root, humanizerPatterns: {} },
      deps: { spawnImpl: () => { spawned = true; throw new Error('should not spawn'); } },
    });
    expect(spawned).toBe(false);
    expect(r.tailored).toBe(false);
    expect(r.usedFallback).toBe(true);
    expect(r.output_path).toBe(masterResumePath(root));
    expect(r.warning).toMatch(/master resume not found/i);
  });

  it('returns a tailored result when the python bridge succeeds (mocked spawn)', async () => {
    // Create a fake master resume so the existence check passes.
    mkdirSync(join(root, 'resumes', 'base'), { recursive: true });
    writeFileSync(masterResumePath(root), 'fake docx');

    const outputPath = join(root, 'resumes', 'output', 'acme.docx');
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      let written = '';
      child.stdin = { write: (s) => { written += s; }, end: () => {
        // Emit a JSON reply on the next tick, echoing nothing sensitive.
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify({
            ok: true, output_path: outputPath, pdf_path: null,
            audit: { emphasized: ['spark'] }, emphasized: 1, summary_line: 'Tailored for Acme',
          }) + '\n'));
          child.emit('close', 0);
        });
      } };
      child.kill = () => {};
      return child;
    };

    const r = await tailorResumeForJob({
      job: { company: 'Acme', title: 'SDE', jdText: 'spark' },
      score: { matchedKeywords: ['spark'], missingKeywords: ['dbt'] },
      config: { root, humanizerPatterns: {} },
      deps: { spawnImpl },
    });

    expect(r.tailored).toBe(true);
    expect(r.usedFallback).toBe(false);
    expect(r.output_path).toBe(outputPath);
    expect(r.summaryLine).toBe('Tailored for Acme');
    expect(r.warning).toBe(null);
  });

  it('falls back with a warning when the python bridge reports an error', async () => {
    mkdirSync(join(root, 'resumes', 'base'), { recursive: true });
    writeFileSync(masterResumePath(root), 'fake docx');

    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {}, end: () => {
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: false, error: 'python-docx missing' }) + '\n'));
          child.emit('close', 1);
        });
      } };
      child.kill = () => {};
      return child;
    };

    const r = await tailorResumeForJob({
      job: { company: 'Acme', title: 'SDE', jdText: 'spark' },
      score: { matchedKeywords: ['spark'], missingKeywords: [] },
      config: { root, humanizerPatterns: {} },
      deps: { spawnImpl },
    });

    expect(r.tailored).toBe(false);
    expect(r.usedFallback).toBe(true);
    expect(r.warning).toMatch(/python-docx missing/);
  });
});
