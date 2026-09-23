/**
 * Browser profiles and application checkpoints are isolated per search
 * profile, and a resumed run never reopens a wall.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { assistApply, browserProfileDirName } from '../../src/automation/applyRunner.js';
import {
  APPLICATION_PHASE, applicationStatePath, createApplicationState, legacyApplicationStatePath,
  resolveApplicationStateStore, transitionApplicationState,
} from '../../src/apply/applicationState.js';

const PACKET = {
  id: 'p1',
  job: { id: 'job-7', url: 'https://boards.greenhouse.io/acme/jobs/7', company: 'Acme', title: 'DE' },
  owner: { candidateName: 'Dana Okafor', profileId: 'dana-data' },
  blockers: [], screeningPlan: { answered: [], needsUser: [] }, fillPlan: { steps: [], uploads: [] },
};

describe('browser profile folder', () => {
  it('is per search profile, and unchanged without one', () => {
    expect(browserProfileDirName({})).toBe('.browser-profile');
    expect(browserProfileDirName({ channel: 'msedge' })).toBe('.browser-profile-msedge');
    expect(browserProfileDirName({ profileId: 'dana-data' })).toBe('.browser-profile-dana-data');
    expect(browserProfileDirName({ profileId: 'dana/../x', channel: 'chrome' })).toBe('.browser-profile-dana-x-chrome');
  });

  it('the runner launches the active profile’s folder', async () => {
    let seen = null;
    await assistApply({
      packet: PACKET,
      config: { root: '/r', profile: { id: 'dana-data' }, candidate: { identity: { fullName: 'Dana Okafor' } }, runtime: {} },
      options: { statePath: false, headless: true },
      deps: { createSession: async (o) => { seen = o.userDataDir; throw new Error('stop here'); } },
    });
    expect(seen).toBe(join('/r', '.browser-profile-dana-data'));
  });
});

describe('checkpoint paths', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'state-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('are keyed by profile, and legacy checkpoints are still found', async () => {
    const profiled = applicationStatePath(root, PACKET);
    const legacy = legacyApplicationStatePath(root, PACKET);
    expect(profiled).toContain(join('application-state', 'dana-data'));
    expect(legacy).not.toContain('dana-data');
    expect(applicationStatePath(root, { job: PACKET.job })).toBe(legacy);

    // A pre-profile "user submitted" duplicate guard must survive the move.
    let state = createApplicationState(PACKET);
    state = transitionApplicationState(state, APPLICATION_PHASE.USER_SUBMITTED, {});
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, JSON.stringify(state));
    const store = resolveApplicationStateStore({ packet: PACKET, root });
    expect((await store.load()).phase).toBe(APPLICATION_PHASE.USER_SUBMITTED);
    await store.save(state);
    expect(existsSync(profiled)).toBe(true);
  });
});

describe('resume URL', () => {
  function storeWith(state) {
    return { path: 'memory://x', load: async () => structuredClone(state), save: async () => {} };
  }
  const config = { candidate: { identity: { fullName: 'Dana Okafor' } }, runtime: {} };

  async function openedUrl(state) {
    let opened = null;
    await assistApply({
      packet: PACKET, config, options: { headless: true },
      deps: {
        stateStore: storeWith(state),
        createSession: async () => ({ page: { url: () => 'x', locator: () => ({ count: async () => 0 }) }, close: async () => {} }),
        openPage: async (_p, url) => { opened = url; return { guard: { blocked: true, kind: 'login', reason: 'x' } }; },
      },
    });
    return opened;
  }

  it('never resumes at a URL recorded as a wall, or a login-shaped URL', async () => {
    let s = createApplicationState(PACKET);
    s = transitionApplicationState(s, APPLICATION_PHASE.BLOCKED, {
      lastUrl: 'https://boards.greenhouse.io/acme/jobs/7/challenge', lastUrlUnsafe: true,
    });
    expect(await openedUrl(s)).toBe(PACKET.job.url);

    let login = createApplicationState(PACKET);
    login = transitionApplicationState(login, APPLICATION_PHASE.BLOCKED, { lastUrl: 'https://acme.test/login?next=1' });
    expect(await openedUrl(login)).toBe(PACKET.job.url);

    let good = createApplicationState(PACKET);
    good = transitionApplicationState(good, APPLICATION_PHASE.ADVANCING, { lastUrl: 'https://boards.greenhouse.io/acme/jobs/7?step=2' });
    expect(await openedUrl(good)).toBe('https://boards.greenhouse.io/acme/jobs/7?step=2');
  });

  it('records a blocked page as unsafe to resume', () => {
    let s = createApplicationState(PACKET);
    s = transitionApplicationState(s, APPLICATION_PHASE.BLOCKED, { lastUrl: 'https://a.test/x', lastUrlUnsafe: true });
    expect(s.lastUrlUnsafe).toBe(true);
    s = transitionApplicationState(s, APPLICATION_PHASE.PRECHECK, {});
    expect(s.lastUrlUnsafe).toBe(true);
    s = transitionApplicationState(s, APPLICATION_PHASE.OPENING, { lastUrl: 'https://a.test/apply' });
    expect(s.lastUrlUnsafe).toBe(false);
  });
});
