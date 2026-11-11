/**
 * Title-fit hot path: faster, and provably the same answers.
 *
 * Measured before: classifyTitleFit ~610-930 µs per title (a fresh RegExp per
 * taxonomy term per call, and the taxonomy scored twice), and sorting 150
 * titles with the priority inside the comparator ~1 s. These tests pin the
 * semantics the optimisation must not change, plus the memo's safety.
 */
import { describe, it, expect } from 'vitest';

import {
  buildProfileVocabulary, classifyTitleFit, titleFitPriority, sortByTitleFit, profileVocabularyFor,
} from '../../src/scoring/profileFit.js';
import {
  loadRoleFamilies, scoreFamilies, scoreFamiliesByKinds, matchText,
} from '../../src/profile/roleFamilies.js';
import { hasNormalizedTerm } from '../../src/utils/textNormalize.js';
import { extractReadableContent } from '../../src/search/normalize.js';
import { loadTestConfig } from './helpers/testConfig.js';

const config = loadTestConfig({ loadEnv: false, env: {} });
const taxonomy = loadRoleFamilies();

/** The ORIGINAL implementation, kept here as the reference oracle. */
function referenceScoreFamilies(text, tax, { kinds } = {}) {
  const hasTerm = (h, term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(h);
  };
  const haystack = matchText(text);
  if (!haystack) return [];
  const use = kinds ?? ['roles', 'domain', 'skills', 'heads'];
  const weightOf = { roles: 'role', domain: 'domain', skills: 'skill', heads: 'head' };
  const out = [];
  for (const family of Object.values(tax.families ?? {})) {
    let score = 0;
    const matched = [];
    for (const kind of use) {
      const weight = tax.weights?.[weightOf[kind]] ?? 1;
      for (const term of family[kind] ?? []) {
        if (!hasTerm(haystack, term)) continue;
        score += Math.min(3, term.split(/\s+/).length) * weight;
        matched.push(term);
      }
    }
    if (score > 0) out.push({ id: family.id, label: family.label, score, matched });
  }
  return out.sort((a, b) => b.score - a.score);
}

const TITLES = [
  'Senior Data Engineer', 'Accounts Payable Administrator', 'Lakehouse Platform Engineer',
  'C++ Developer (Low latency)', 'BI – Reporting Engineer', 'Registered Nurse, ICU', '.NET Architect',
  'Power BI Developer – MES 4.0 Reporting', 'Head of Brand Marketing', '', 'CI/CD Platform Lead',
];

describe('family scoring is unchanged by the single-pass rewrite', () => {
  it('matches the original implementation for every kind subset', () => {
    for (const title of TITLES) {
      expect(scoreFamilies(title, taxonomy), title).toEqual(referenceScoreFamilies(title, taxonomy));
      const subject = { kinds: ['roles', 'domain', 'skills'] };
      expect(scoreFamilies(title, taxonomy, subject)).toEqual(referenceScoreFamilies(title, taxonomy, subject));
      const [all, subj] = scoreFamiliesByKinds(title, taxonomy, [
        ['roles', 'domain', 'skills', 'heads'], ['roles', 'domain', 'skills'],
      ]);
      expect(all).toEqual(referenceScoreFamilies(title, taxonomy));
      expect(subj).toEqual(referenceScoreFamilies(title, taxonomy, subject));
    }
  });

  it('the prefiltered matcher keeps whole-word boundaries', () => {
    expect(hasNormalizedTerm('nosql engineer', 'sql')).toBe(false);
    expect(hasNormalizedTerm('sql engineer', 'sql')).toBe(true);
    expect(hasNormalizedTerm('senior c++ developer', 'c++')).toBe(true);
    expect(hasNormalizedTerm('felt belt', 'elt')).toBe(false);
    expect(hasNormalizedTerm('', 'x')).toBe(false);
  });
});

describe('classifyTitleFit memo', () => {
  it('returns identical verdicts on repeat calls, and each caller its own signals array', () => {
    const vocab = buildProfileVocabulary(config.candidate);
    const first = classifyTitleFit('Senior Data Engineer', vocab);
    first.signals.push('MUTATED');
    const second = classifyTitleFit('Senior Data Engineer', vocab);
    expect(second.signals).not.toContain('MUTATED');
    expect(second.verdict).toBe(first.verdict);
  });

  it('is keyed per vocabulary, so a different profile gets its own verdicts', () => {
    const a = buildProfileVocabulary(config.candidate);
    const nurse = buildProfileVocabulary({ targetTitles: ['Registered Nurse'], seniority: 'senior' });
    expect(classifyTitleFit('Registered Nurse, ICU', nurse).verdict).toBe('accept');
    expect(classifyTitleFit('Registered Nurse, ICU', a).verdict).not.toBe('accept');
  });

  it('profileVocabularyFor builds once per candidate object', () => {
    expect(profileVocabularyFor(config.candidate)).toBe(profileVocabularyFor(config.candidate));
    expect(profileVocabularyFor(null)).toBeNull();
  });

  it('classifies a thousand distinct titles quickly (was ~0.6-0.9 s)', () => {
    const vocab = buildProfileVocabulary(config.candidate);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i += 1) classifyTitleFit(`Data Platform Engineer ${i}`, vocab);
    expect(performance.now() - t0).toBeLessThan(600);
  });
});

describe('sortByTitleFit', () => {
  it('orders by priority, keeps input order on ties, and computes each priority once', () => {
    const vocab = buildProfileVocabulary(config.candidate);
    const items = ['Accounts Payable Administrator', 'Office Manager', 'Senior Data Engineer', 'Warehouse Associate']
      .map((title, i) => ({ title, i }));
    let calls = 0;
    const sorted = sortByTitleFit(items, (x) => { calls += 1; return x.title; }, vocab);
    expect(calls).toBe(items.length);
    const reference = [...items].sort((a, b) => titleFitPriority(b.title, vocab) - titleFitPriority(a.title, vocab));
    expect(sorted.map((x) => x.i)).toEqual(reference.map((x) => x.i));
  });
});

describe('extractReadableContent on nested matching containers', () => {
  it('still picks the outermost description and stays fast', () => {
    const body = 'Build pipelines in Spark and SQL for the analytics platform. '.repeat(8);
    const html = `<html><body>${'<div class="description">'.repeat(300)}${body}${'</div>'.repeat(300)}</body></html>`;
    const t0 = performance.now();
    const out = extractReadableContent(html);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(out.method).toBe('container');
    expect(out.text).toContain('Build pipelines');
  });
});
