import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { keywordsForJob, masterResumePath, tailorResumeForJob, vocabularyFromScoring } from '../../src/resume/tailorRunner.js';

describe('keywordsForJob', () => {
  it('de-dupes matched + missing keywords, matched first', () => {
    const kws = keywordsForJob({
      matchedKeywords: ['Spark', 'Airflow'],
      missingKeywords: ['airflow', 'dbt'],
    });
    expect(kws).toEqual(['Spark', 'Airflow', 'dbt']);
  });
});

describe('vocabularyFromScoring', () => {
  it('flattens and de-dupes every scoring keyword category', () => {
    const vocab = vocabularyFromScoring({
      keywords: {
        titles: ['Data Engineer', 'data engineer'],
        azureFabric: ['Databricks', 'ADF'],
        languages: ['Python', 'SQL'],
      },
    });
    // De-duped (case-insensitive), order preserved, all categories flattened.
    expect(vocab).toEqual(['Data Engineer', 'Databricks', 'ADF', 'Python', 'SQL']);
  });

  it('returns [] when scoring has no keywords', () => {
    expect(vocabularyFromScoring({})).toEqual([]);
    expect(vocabularyFromScoring()).toEqual([]);
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
    // A successful tailor leaves a file behind, so the mock has to as well:
    // the runner now verifies that the path python reports back actually
    // exists. That check is what catches a Node/Python encoding disagreement
    // over a non-ASCII employer name, which once wrote resumes into a
    // directory nobody else could find.
    mkdirSync(join(root, 'resumes', 'output'), { recursive: true });
    writeFileSync(outputPath, 'tailored docx');
    let written = '';
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: (s) => { written += s; }, end: () => {
        // Emit a JSON reply on the next tick, echoing nothing sensitive.
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify({
            ok: true, output_path: outputPath, pdf_path: null,
            audit: { emphasized: ['spark'] }, emphasized: 1, summary_line: 'Tailored for Acme',
            ats_report: { match_score: 78, band: 'strong', tier1: { missing: [] } },
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
      config: {
        root,
        humanizerPatterns: {},
        scoring: {
          keywords: { azureFabric: ['Databricks'] },
          evidenceAliases: { spark: ['pyspark'] },
        },
        atsResume: { coverage: {} },
      },
      deps: { spawnImpl },
    });

    expect(r.tailored).toBe(true);
    expect(r.usedFallback).toBe(false);
    expect(r.output_path).toBe(outputPath);
    expect(r.summaryLine).toBe('Tailored for Acme');
    expect(r.warning).toBe(null);
    // The ATS report flows through to the caller.
    expect(r.atsReport).toMatchObject({ match_score: 78, band: 'strong' });
    // The request carried the grounding vocabulary + ATS config to Python.
    const sent = JSON.parse(written);
    expect(sent.vocabulary).toContain('Databricks');
    expect(sent.evidence_aliases).toEqual({ spark: ['pyspark'] });
    expect(sent.ats_config).toMatchObject({ coverage: {} });
  });

  it('survives a python that exits without reading a large request (async EPIPE)', async () => {
    mkdirSync(join(root, 'resumes', 'base'), { recursive: true });
    writeFileSync(masterResumePath(root), 'fake docx');
    // A REAL child that exits at once, fed well past the ~64 KB pipe buffer, so
    // the write fails asynchronously on the stream — previously an
    // uncaughtException that ended the whole CLI run.
    const spawnImpl = (_exe, _args, opts) => spawn(process.execPath, ['-e', 'process.exit(3)'], opts);
    const r = await tailorResumeForJob({
      job: { company: 'Acme', title: 'SDE', jdText: 'spark '.repeat(60_000) },
      score: { matchedKeywords: ['spark'], missingKeywords: [] },
      config: { root, humanizerPatterns: {} },
      deps: { spawnImpl },
    });
    expect(r.tailored).toBe(false);
    expect(r.usedFallback).toBe(true);
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
