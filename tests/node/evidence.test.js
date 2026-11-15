/**
 * One evidence check (audit R2, R3, R13/D3): the JavaScript twin of
 * src/resume/evidence.py, held to the same cases. If this file and
 * tests/python/test_evidence.py both pass, the scorer and the tailor cannot
 * answer "does this text show this skill?" differently.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { findEvidence, isEveryday, occurrences, postingText } from '../../src/resume/evidence.js';

const { cases, evidenceCases } = JSON.parse(readFileSync(new URL('../shared/evidence_cases.json', import.meta.url), 'utf8'));

describe('the shared evidence cases', () => {
  it.each(cases.map((c) => [`${c.term} | ${c.line.slice(0, 40)} | ${c.expect}`, c]))('%s', (_name, c) => {
    const found = occurrences(c.term, c.line, { vocabulary: c.vocabulary ?? [], inList: c.inList === true });
    expect(found.length > 0, c.why).toBe(c.expect);
  });
});

describe('the shared find-evidence cases', () => {
  it.each(evidenceCases.map((c) => [`${c.term} | ${c.expect}`, c]))('%s', (_name, c) => {
    expect(findEvidence(c.term, c.lines, { aliases: c.aliases ?? {} }).length > 0, c.why).toBe(c.expect);
  });
});

describe('details the Python twin also pins', () => {
  it('returns the span of the term itself', () => {
    const line = 'Built forecasting models in R and Python.';
    const [[start, end]] = occurrences('r', line);
    expect(line.slice(start, end)).toBe('R');
    const plural = 'Built data pipelines in Airflow.';
    const [[s2, e2]] = occurrences('data pipeline', plural);
    expect(plural.slice(s2, e2)).toBe('data pipelines');
  });

  it('knows which terms are everyday', () => {
    for (const t of ['go', 'r', 'c', 'excel', 'access', 'word', 'x']) expect(isEveryday(t), t).toBe(true);
    for (const t of ['python', 'sql', 'data pipeline', 'c++', 'ml', 'ai']) expect(isEveryday(t), t).toBe(false);
  });

  it('finds the line, honouring aliases', () => {
    const lines = ['Built a Golang service for payments.', 'Wrote SQL.'];
    expect(findEvidence('go', lines, { aliases: { go: ['golang'] } }))
      .toEqual([{ matched_term: 'golang', resume_text: 'Built a Golang service for payments.' }]);
    expect(findEvidence('go', lines)).toEqual([]);
  });

  it('prepares a posting the way the Python classifier does', () => {
    const jd = 'Required:   Spark.\n\nLegitimate Example recruiters will never ask for banking information. Python too.';
    expect(postingText(jd)).toBe('Required: Spark. Python too.');
  });
});
