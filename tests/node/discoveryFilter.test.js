import { describe, it, expect } from 'vitest';

import { classifyDiscovery, candidateStackTerms } from '../../src/search/discoveryFilter.js';
import { normalizeJob } from '../../src/search/normalize.js';

const candidate = {
  targetTitles: ['Senior Data Engineer', 'Lead Data Engineer', 'Azure Data Engineer'],
  seniority: 'senior',
  technicalStack: {
    cloud: ['Azure', 'Microsoft Fabric', 'Synapse'],
    dataEngineering: ['Azure Data Factory', 'Delta Lake', 'PySpark', 'Databricks'],
    languages: ['Python', 'SQL'],
  },
  locationPreferences: { remote: true, excludedLocations: ['India'] },
};

const scoring = { keywords: { azureFabric: ['Microsoft Fabric'], languages: ['Python', 'SQL'] } };

describe('classifyDiscovery (permissive)', () => {
  it('marks a strong match: target title + multiple stack signals', () => {
    const job = normalizeJob({
      source: 'greenhouse', company: 'Acme', title: 'Senior Data Engineer', location: 'Remote, US',
      jdText: 'Build pipelines on Azure Databricks with Delta Lake, PySpark and Synapse. Python and SQL.',
    });
    const r = classifyDiscovery(job, { candidate, scoring });
    expect(r.match).toBe('strong');
    expect(r.signals.some((s) => s.startsWith('title:'))).toBe(true);
    expect(r.signals.some((s) => s.startsWith('stack:'))).toBe(true);
  });

  it('marks a weak match: relevant title but thin/garbled JD (imperfect extraction)', () => {
    const job = normalizeJob({
      source: 'workday', company: 'Acme', title: 'Staff Data Engineer', location: 'Remote, US',
      jdText: 'Apply now. See description on site.',
    });
    const r = classifyDiscovery(job, { candidate, scoring });
    expect(r.match).toBe('weak'); // role-token title signal keeps it alive for scoring
  });

  it('marks no_match when neither title nor stack signal is present', () => {
    const job = normalizeJob({
      source: 'manual', company: 'BrandCo', title: 'Marketing Manager', location: 'New York, NY',
      jdText: 'Own brand strategy and campaign calendars.',
    });
    const r = classifyDiscovery(job, { candidate, scoring });
    expect(r.match).toBe('no_match');
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('never throws and never discards: returns a result even with empty job', () => {
    const r = classifyDiscovery({}, { candidate, scoring });
    expect(['strong', 'weak', 'no_match']).toContain(r.match);
  });

  it('notes excluded location but does not downgrade below the title/stack signal', () => {
    const job = normalizeJob({
      source: 'greenhouse', company: 'Acme', title: 'Senior Data Engineer', location: 'Bangalore, India',
      jdText: 'Azure Databricks, Delta Lake, PySpark, Synapse, Python, SQL.',
    });
    const r = classifyDiscovery(job, { candidate, scoring });
    expect(r.match).toBe('strong');
    expect(r.reasons.some((x) => x.includes('excludedLocations'))).toBe(true);
  });

  it('flattens the candidate technical stack', () => {
    expect(candidateStackTerms(candidate)).toContain('PySpark');
    expect(candidateStackTerms({})).toEqual([]);
  });
});
