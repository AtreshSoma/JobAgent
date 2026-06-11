/**
 * Regression: every role title configured in candidate.targetTitles must be
 * recognized by the discovery classifier. This guards against a config/filter
 * drift where a role the user explicitly targets (e.g. "Data Analytics
 * Engineer") silently classifies as no_match and never reaches scoring.
 */
import { describe, it, expect } from 'vitest';

import { classifyDiscovery } from '../../src/search/discoveryFilter.js';
import { loadConfig } from '../../src/config/loadConfig.js';

const config = loadConfig({ loadEnv: false, env: {} });

/** A JD with enough of the candidate's real stack to carry the stack signal. */
const STACK_JD = 'Build pipelines with Azure Data Factory, Azure Databricks, PySpark, '
  + 'Python and SQL. Power BI semantic models. Delta Lake medallion architecture.';

describe('discovery covers every configured target title', () => {
  const titles = config.candidate.targetTitles;

  it('the role list from the search strategy is configured', () => {
    for (const required of [
      'Senior Data Engineer', 'Data Engineer', 'Analytics Engineer',
      'Data Analytics Engineer', 'BI Engineer', 'ETL Developer',
      'Azure Data Engineer', 'Data Platform Engineer',
      'Data Warehouse Engineer', 'Power BI Developer',
    ]) {
      expect(titles).toContain(required);
    }
  });

  it.each(config.candidate.targetTitles)('"%s" classifies as a discovery match', (title) => {
    const result = classifyDiscovery(
      { title, jdText: STACK_JD, location: 'Remote, US' },
      { candidate: config.candidate, scoring: config.scoring },
    );
    expect(['strong', 'weak']).toContain(result.match);
    expect(result.match).toBe('strong'); // title hit + >=2 stack hits
  });

  it('an unrelated role still classifies as no_match', () => {
    const result = classifyDiscovery(
      { title: 'Registered Nurse', jdText: 'Patient care in a clinical setting.' },
      { candidate: config.candidate, scoring: config.scoring },
    );
    expect(result.match).toBe('no_match');
  });
});
