import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/logging/db.js';
import { JobLogger, EVENT_TYPES } from '../../src/logging/jobLogger.js';

// A silent logger stub so tests don't print pino output.
const silentLogger = {
  info() {}, warn() {}, error() {}, debug() {},
};

describe('JobLogger', () => {
  let db;
  let jl;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    jl = new JobLogger({ db, logger: silentLogger, runId: 'run-1' });
  });
  afterEach(() => { db.close(); });

  it('records run lifecycle in run_log and events', () => {
    jl.startRun('DRY_RUN');
    const run = jl.endRun({ jobs_found: 3, jobs_discarded: 1 });
    expect(run.mode).toBe('DRY_RUN');
    expect(run.jobs_found).toBe(3);
    expect(run.ended_at).toBeTruthy();

    const types = db.listEvents().map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining([EVENT_TYPES.RUN_START, EVENT_TYPES.RUN_END]));
  });

  it('persists events with redacted metadata', () => {
    jl.event(EVENT_TYPES.JOB_FOUND, {
      jobId: 'j1',
      message: 'Found a job',
      meta: { source: 'dice', password: 'secret' },
    });
    const events = db.listEvents('j1');
    expect(events).toHaveLength(1);
    const meta = JSON.parse(events[0].metadata);
    expect(meta.source).toBe('dice');
    expect(meta.password).toBe('[REDACTED]');
  });

  it('error() logs at error level and stores an event', () => {
    const id = jl.error('Boom', { code: 'X' }, 'j2');
    expect(typeof id).toBe('string');
    const events = db.listEvents('j2');
    expect(events[0].event_type).toBe(EVENT_TYPES.ERROR);
  });
});
