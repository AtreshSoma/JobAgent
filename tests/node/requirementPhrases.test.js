/**
 * What a posting asks for that your vocabulary does not know (audit R12).
 *
 * Tailoring and gaps work from scoring's vocabulary, so a requirement outside
 * it was invisible: no reordering, no gap. These phrases come from the
 * posting's requirement sections, word for word, ranked by how many stored
 * postings ask for them, and become vocabulary only when the person says so.
 */
import { describe, expect, it } from 'vitest';

import { corpusFrequency, requirementPhrases } from '../../src/scoring/requirementPhrases.js';

const JD = `About the team
We build the data platform behind our finance products.

Responsibilities
- Design Kubernetes operators for the scheduling team
- Partner with analysts

Requirements
- 5+ years of experience with Python and SQL
- Hands-on experience with Dagster or Prefect
- Strong knowledge of Apache Iceberg
- Excellent communication skills
- Bachelor's degree in Computer Science

Nice to have
- Familiarity with DuckDB
- Experience with Great Expectations is a plus

Benefits
- Health insurance and a 401k`;

const names = (list) => list.map((p) => p.phrase);

describe('requirement phrases', () => {
  const found = requirementPhrases(JD, { vocabulary: ['python', 'sql'] });

  it('takes items from requirement sections only, word for word', () => {
    expect(names(found)).toEqual(expect.arrayContaining(['Dagster', 'Prefect', 'Apache Iceberg', 'DuckDB', 'Great Expectations']));
    for (const p of found) expect(JD).toContain(p.phrase);
    // Responsibilities and benefits are not requirements.
    expect(names(found)).not.toContain('Kubernetes operators');
    expect(names(found).join(' ')).not.toMatch(/Health insurance|401k/);
  });

  it('marks what the posting prefers', () => {
    expect(found.find((p) => p.phrase === 'DuckDB')).toMatchObject({ preferred: true });
    expect(found.find((p) => p.phrase === 'Dagster')).toMatchObject({ preferred: false });
  });

  it('leaves out what the vocabulary already has, soft skills, years and degrees', () => {
    expect(names(found).map((n) => n.toLowerCase())).not.toEqual(expect.arrayContaining(['python']));
    expect(names(found).join(' ')).not.toMatch(/communication|years|degree|Bachelor/i);
  });

  it('says whether the resume already shows each one', () => {
    const withResume = requirementPhrases(JD, { vocabulary: [], resumeLines: ['Ran Dagster pipelines for finance.'] });
    expect(withResume.find((p) => p.phrase === 'Dagster')).toMatchObject({ inResume: true });
    expect(withResume.find((p) => p.phrase === 'Prefect')).toMatchObject({ inResume: false });
  });

  it('ranks by how many stored postings ask for it', () => {
    const corpus = corpusFrequency(['uses Prefect daily', 'Prefect and Dagster', 'Prefect here', 'nothing']);
    const ranked = requirementPhrases(JD, { vocabulary: [], frequency: corpus });
    expect(names(ranked).slice(0, 2)).toEqual(['Prefect', 'Dagster']);
    expect(ranked[0]).toMatchObject({ postings: 3 });
  });

  it('finds nothing in a posting with no requirement section', () => {
    expect(requirementPhrases('We are a friendly team. Apply today!')).toEqual([]);
  });
});
