import { describe, it, expect } from 'vitest';

import { extractJdRequirements } from '../../src/llm/jdRequirements.js';
import { llmSettings, parseJsonObject } from '../../src/llm/client.js';

const JD = [
  'We are hiring a Senior Data Engineer.',
  'You will build pipelines with dimensional modeling and Apache Iceberg.',
  'Required qualifications: 5+ years of SQL, dbt, and Snowflake.',
  'Preferred qualifications: Kubernetes and Terraform.',
  'Our team values collaboration and ownership.',
].join(' ').padEnd(400, ' .');

/** A provider double that returns exactly the requirements list we hand it. */
function providerReturning(requirements) {
  return {
    settings: {
      enabled: true, model: 'test-model', cacheDir: null,
      timeoutMs: 500, baseUrl: 'https://example.invalid/v1', apiKey: 'k',
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ requirements }) } }],
      }),
    }),
  };
}

describe('LLM assist is off unless explicitly enabled', () => {
  it('is disabled with no env configuration', () => {
    const s = llmSettings({});
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/not enabled/i);
  });

  it('stays disabled when the flag is on but no key is present', () => {
    const s = llmSettings({ LLM_ASSIST: 'on' });
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/no api key/i);
  });

  it('enables only with both flag and key', () => {
    const s = llmSettings({ LLM_ASSIST: 'on', NVIDIA_API_KEY: 'nvapi-test' });
    expect(s.enabled).toBe(true);
    expect(s.reason).toBeNull();
  });

  it('extraction is a no-op (never throws) when disabled', async () => {
    const r = await extractJdRequirements({ jdText: JD, title: 'Senior Data Engineer', env: {} });
    expect(r.ok).toBe(false);
    expect(r.phrases).toEqual([]);
    expect(r.provenance.skipped).toMatch(/not enabled/i);
  });
});

describe('grounding verification makes fabrication structurally impossible', () => {
  it('accepts only phrases that appear verbatim in the posting', async () => {
    const r = await extractJdRequirements(
      { jdText: JD, title: 'Senior Data Engineer' },
      providerReturning([
        { phrase: 'dimensional modeling', importance: 'required' },
        { phrase: 'Apache Iceberg', importance: 'required' },
        { phrase: 'Kubernetes', importance: 'preferred' },
        // Fabricated: a plausible expansion that the JD never mentions.
        { phrase: 'Azure Data Factory', importance: 'required' },
        // Fabricated: an invented seniority claim.
        { phrase: '15 years of Kafka leadership', importance: 'required' },
      ]),
    );

    expect(r.ok).toBe(true);
    expect(r.phrases).toEqual(['dimensional modeling', 'Apache Iceberg', 'Kubernetes']);
    expect(r.rejected.map((x) => x.phrase)).toEqual([
      'Azure Data Factory', '15 years of Kafka leadership',
    ]);
    for (const rejected of r.rejected) {
      expect(rejected.reason).toMatch(/not present in the job description/);
    }
  });

  it('preserves the model\'s required/preferred split for accepted phrases', async () => {
    const r = await extractJdRequirements(
      { jdText: JD },
      providerReturning([
        { phrase: 'dbt', importance: 'required' },
        { phrase: 'Terraform', importance: 'preferred' },
      ]),
    );
    expect(r.required).toEqual(['dbt']);
    expect(r.preferred).toEqual(['Terraform']);
  });

  it('tolerates punctuation/spacing differences without accepting new content', async () => {
    const jd = 'Required: experience with CI/CD pipelines and “data quality” checks.'.padEnd(400, ' .');
    const r = await extractJdRequirements(
      { jdText: jd },
      providerReturning([
        { phrase: 'CI/CD', importance: 'required' },
        { phrase: '"data quality"', importance: 'required' },
        { phrase: 'data governance', importance: 'required' },
      ]),
    );
    expect(r.phrases).toContain('CI/CD');
    expect(r.phrases).not.toContain('data governance');
  });

  it('rejects junk shapes (empty, absurdly long) without failing the run', async () => {
    const r = await extractJdRequirements(
      { jdText: JD },
      providerReturning([
        { phrase: '', importance: 'required' },
        { phrase: 'x'.repeat(200), importance: 'required' },
        { phrase: 'Snowflake', importance: 'required' },
      ]),
    );
    expect(r.ok).toBe(true);
    expect(r.phrases).toEqual(['Snowflake']);
  });

  it('falls back safely when the provider errors', async () => {
    const r = await extractJdRequirements({ jdText: JD }, {
      settings: {
        enabled: true, model: 'test-model', cacheDir: null,
        timeoutMs: 500, baseUrl: 'https://example.invalid/v1', apiKey: 'k',
      },
      fetchImpl: async () => { throw new Error('connection refused'); },
    });
    expect(r.ok).toBe(false);
    expect(r.phrases).toEqual([]);
    expect(r.provenance.skipped).toMatch(/connection refused/);
  });

  it('falls back safely when the provider returns non-JSON', async () => {
    const r = await extractJdRequirements({ jdText: JD }, {
      settings: {
        enabled: true, model: 'test-model', cacheDir: null,
        timeoutMs: 500, baseUrl: 'https://example.invalid/v1', apiKey: 'k',
      },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'I think you should use Spark!' } }] }),
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.phrases).toEqual([]);
  });

  it('skips very short job descriptions instead of guessing', async () => {
    const r = await extractJdRequirements({ jdText: 'Data engineer wanted.' }, providerReturning([
      { phrase: 'Data engineer', importance: 'required' },
    ]));
    expect(r.ok).toBe(false);
    expect(r.provenance.skipped).toMatch(/too short/i);
  });
});

describe('parseJsonObject tolerates real-world model formatting', () => {
  it('reads a fenced JSON block', () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('reads JSON embedded in prose', () => {
    expect(parseJsonObject('Here you go: {"a":2} — hope that helps')).toEqual({ a: 2 });
  });
  it('returns null for an array or scalar', () => {
    expect(parseJsonObject('[1,2]')).toBeNull();
    expect(parseJsonObject('"hi"')).toBeNull();
  });
});
