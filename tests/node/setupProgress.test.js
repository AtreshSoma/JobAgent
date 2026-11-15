/**
 * The setup card's grouping (S1). Built from the template detector itself, so a
 * field added to the detector without a home on the card fails here instead of
 * silently dropping out of the count.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { findPlaceholders, GUARDED_PROFILE_FIELDS } from '../../src/config/placeholders.js';
import { itemForPath, SETUP_GROUPS, SETUP_ITEMS, setupProgress } from '../../src/config/setupProgress.js';
import { dashboardStats } from '../../src/dashboard/data.js';
import { openDatabase } from '../../src/logging/db.js';

const REPO = join(import.meta.dirname, '..', '..');
const example = (name) => JSON.parse(readFileSync(join(REPO, 'config', `${name}.example.json`), 'utf8'));
const fresh = () => ({
  candidate: example('candidate'),
  screeningAnswers: example('screening_answers'),
  coverLetter: example('cover_letter'),
});
const answer = (bundle, id, text) => { bundle.screeningAnswers.answers.find((a) => a.id === id).answer = text; };
const item = (progress, key) => progress.groups.flatMap((g) => g.items).find((i) => i.key === key);

describe('every detector path has exactly one home on the card', () => {
  it('each guarded profile field', () => {
    for (const field of GUARDED_PROFILE_FIELDS) {
      // `[*]` expands to an index; a list-valued leaf (highlights) to an index too.
      const concrete = field.path.replace(/\[\*\]/g, '[0]');
      const paths = field.path.endsWith('highlights') ? [concrete, `${concrete}[0]`] : [concrete];
      for (const path of paths) expect(itemForPath(path), `${path} (${field.label})`).not.toBeNull();
    }
  });

  it('each entry the detector reports on the shipped example profile', () => {
    const { placeholders } = findPlaceholders(fresh());
    expect(placeholders.length).toBeGreaterThan(15);
    for (const hit of placeholders) expect(itemForPath(hit.path), `${hit.file}: ${hit.path}`).not.toBeNull();
  });

  it('no two items claim the same path', () => {
    const { placeholders } = findPlaceholders(fresh());
    for (const hit of placeholders) {
      const claims = SETUP_ITEMS.filter((i) => i.paths.some((p) => (p instanceof RegExp ? p.test(hit.path) : p === hit.path)));
      expect(claims.map((c) => c.key), hit.path).toHaveLength(1);
    }
  });

  it('every item sits in a known group', () => {
    const groups = new Set(SETUP_GROUPS.map((g) => g.key));
    for (const i of SETUP_ITEMS) expect(groups.has(i.group), i.key).toBe(true);
  });
});

describe('a fresh profile', () => {
  const progress = setupProgress(fresh());

  it('is not ready, exactly when the detector says so', () => {
    expect(progress.ok).toBe(false);
    expect(progress.ok).toBe(findPlaceholders(fresh()).ok);
  });

  it('counts things to fill in, not stored copies', () => {
    expect(findPlaceholders(fresh()).placeholders.length).toBe(20);
    expect(progress).toMatchObject({ total: 13, done: 0 });
    expect(progress.groups.map((g) => [g.key, g.total, g.done])).toEqual([
      ['contact', 8, 0], ['authorization', 1, 0], ['experience', 2, 0], ['screening', 2, 0],
    ]);
  });

  it('shows work authorization once, though five stored values read from it', () => {
    const auth = progress.groups.find((g) => g.key === 'authorization');
    expect(auth.items).toHaveLength(1);
    expect(auth.items[0]).toMatchObject({ label: 'Work authorization and sponsorship', personOnly: true });
    // The same template text is shown once, not once per copy.
    expect(new Set(auth.items[0].values).size).toBe(auth.items[0].values.length);
  });

  it('shows years of experience once, and work history with education as one item', () => {
    const exp = progress.groups.find((g) => g.key === 'experience');
    expect(exp.items.map((i) => i.label)).toEqual(['Years of experience', 'Work history and education']);
    expect(item(progress, 'background').fix).toMatchObject({ action: 'fill-profile-from-resume' });
  });

  it('never offers the resume for work authorization, sponsorship or salary', () => {
    for (const key of ['authorization', 'salary']) {
      const it_ = item(progress, key);
      expect(it_.personOnly, key).toBe(true);
      expect(it_.fix.action, key).toBeUndefined();
      expect(it_.fix.editor, key).toBe('answers');
    }
  });

  it('points each item at a screen, never a file or a command', () => {
    for (const i of progress.groups.flatMap((g) => g.items)) {
      expect(['details', 'answers', undefined]).toContain(i.fix.editor);
      expect(JSON.stringify(i)).not.toMatch(/\.json|npm |npx |node /);
    }
  });
});

describe('progress as values are filled in', () => {
  it('contact details count one by one', () => {
    const bundle = fresh();
    bundle.candidate.identity.fullName = 'Casey Fixture';
    bundle.candidate.contact.email = 'casey@fixture.test';
    const progress = setupProgress(bundle);
    expect(progress.groups.find((g) => g.key === 'contact')).toMatchObject({ total: 8, done: 2 });
    expect(progress).toMatchObject({ total: 13, done: 2, ok: false });
  });

  it('work authorization stays pending until every copy is real, and opens the answer still missing', () => {
    const bundle = fresh();
    answer(bundle, 'work_authorization', 'Authorized to work in the United States on an H-1B visa.');
    bundle.candidate.workAuthorization.status = 'H-1B';
    bundle.candidate.workAuthorization.details = 'H-1B';
    const auth = item(setupProgress(bundle), 'authorization');
    expect(auth.done).toBe(false);
    expect(auth.fix.field).toBe('require_sponsorship');
  });

  it('a profile with nothing left is ok, and the card agrees with the detector', () => {
    const bundle = {
      candidate: { identity: { fullName: 'Casey Fixture' }, contact: { email: 'casey@fixture.test' } },
      screeningAnswers: { answers: [{ id: 'salary_expectation', answer: '150000' }] },
      coverLetter: {},
    };
    const progress = setupProgress(bundle);
    expect(progress).toMatchObject({ ok: true, done: 13, total: 13 });
    expect(findPlaceholders(bundle).ok).toBe(true);
  });

  it('a saved answer the person added, still holding template text, is counted and holds applying', () => {
    const bundle = fresh();
    bundle.screeningAnswers.answers.push({ id: 'relocation_ok', patterns: ['relocate'], answer: 'YOUR relocation answer.' });
    const progress = setupProgress(bundle);
    expect(progress.total).toBe(14);
    expect(item(progress, 'answer:relocation_ok')).toMatchObject({ label: 'Relocation ok', done: false, fix: { editor: 'answers', field: 'relocation_ok' } });
    expect(progress.ok).toBe(false);
  });
});

describe('the Next panel before any search has run (S1)', () => {
  const verbs = (stats) => stats.nextActions.map((a) => a.verb);

  it('says "Run your first search", not "nothing new in the last 24 hours"', () => {
    const db = openDatabase({ path: ':memory:' });
    const stats = dashboardStats(db);
    expect(stats.everSearched).toBe(false);
    expect(verbs(stats)).toContain('Run your first search');
    expect(JSON.stringify(stats.nextActions)).not.toMatch(/24 ?h/);
    // A search, not a board filter: the panel's button runs discovery.
    expect(stats.nextActions.find((a) => a.verb === 'Run your first search').filter).toBeNull();
    db.close();
  });

  it('after a search that found nothing, says so', () => {
    const db = openDatabase({ path: ':memory:' });
    db.insertRunLog({ run_id: 'r1', mode: 'DRY_RUN', started_at: '2026-11-14T10:00:00.000Z', ended_at: '2026-11-14T10:05:00.000Z' });
    const stats = dashboardStats(db);
    expect(stats.everSearched).toBe(true);
    expect(verbs(stats)).not.toContain('Run your first search');
    expect(verbs(stats)).toContain('Find new jobs');
    db.close();
  });
});
