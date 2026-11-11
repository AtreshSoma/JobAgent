import { describe, it, expect } from 'vitest';
import { classifySponsorship } from '../../src/scoring/sponsorshipClassifier.js';
import { scoreJob } from '../../src/scoring/scorer.js';
import { explainScore, rawTier, TIERS } from '../../src/scoring/explainScore.js';
import { loadTestConfig, legacyScoringShape } from './helpers/testConfig.js';
import * as F from './fixtures/jobs.js';

// These exercise the LEGACY weights/keywords scoring shape, which a
// scoring.json predating search profiles still uses and which must keep
// scoring identically. The shipped config/scoring.json is now generated from
// the active profile — see tests/node/profileDriven.test.js for that path.
const loaded = loadTestConfig({ loadEnv: false, env: {} });
const scoring = legacyScoringShape(loaded.scoring);
const { candidate } = loaded;
const sponConfig = scoring.sponsorship;

describe('sponsorshipClassifier', () => {
  it('Confirmed when JD affirms sponsorship', () => {
    expect(classifySponsorship(F.confirmedSponsorship, sponConfig).status).toBe('Confirmed');
  });
  it('Confirmed when willingToSponsor flag set', () => {
    expect(classifySponsorship({ willingToSponsor: true }, sponConfig).status).toBe('Confirmed');
  });
  it('Likely for a configured big-sponsor company', () => {
    expect(classifySponsorship({ company: 'Microsoft', jdText: '' }, sponConfig).status).toBe('Likely');
  });
  it('Unconfirmed when no signal', () => {
    expect(classifySponsorship({ company: 'Tiny LLC', jdText: 'data engineer' }, sponConfig).status).toBe('Unconfirmed');
  });
});

describe('scorer', () => {
  it('scores a strong Azure Fabric senior role highly', () => {
    const sponsorship = classifySponsorship(F.azureFabricSenior, sponConfig);
    const result = scoreJob(F.azureFabricSenior, { scoring, sponsorship, candidate, now: F.NOW });
    expect(result.total).toBeGreaterThanOrEqual(75);
    expect(result.matchedKeywords).toEqual(expect.arrayContaining(['azure', 'pyspark']));
    expect(result.sponsorship).toBe('Confirmed');
  });

  it('scores a Snowflake-only mismatch lower than the Azure role', () => {
    const azureSpon = classifySponsorship(F.azureFabricSenior, sponConfig);
    const snowSpon = classifySponsorship(F.snowflakeMismatch, sponConfig);
    const azure = scoreJob(F.azureFabricSenior, { scoring, sponsorship: azureSpon, candidate, now: F.NOW });
    const snow = scoreJob(F.snowflakeMismatch, { scoring, sponsorship: snowSpon, candidate, now: F.NOW });
    expect(snow.total).toBeLessThan(azure.total);
  });

  it('is deterministic', () => {
    const s = classifySponsorship(F.azureFabricSenior, sponConfig);
    const a = scoreJob(F.azureFabricSenior, { scoring, sponsorship: s, candidate, now: F.NOW });
    const b = scoreJob(F.azureFabricSenior, { scoring, sponsorship: s, candidate, now: F.NOW });
    expect(a.total).toBe(b.total);
    expect(a.raw).toBe(b.raw);
  });

  // REGRESSION: matching used to be plain substring containment, which
  // credited "sql" for JD text that explicitly says "NoSQL" — the opposite
  // signal. Verified live against the real job corpus before this fix; see
  // textNormalize.test.js for the matcher-level tests. This confirms the fix
  // holds through the full scoring pipeline, not just the matcher in isolation.
  it('does not credit "sql" for a role that explicitly wants NoSQL, not SQL', () => {
    const job = {
      source: 'greenhouse', company: 'Acme', title: 'Senior Data Engineer',
      jdText: 'Senior Data Engineer to build pipelines against NoSQL databases like MongoDB and DynamoDB. Strictly non-relational, schemaless data stores.',
    };
    const sponsorship = classifySponsorship(job, sponConfig);
    const result = scoreJob(job, { scoring, sponsorship, candidate, now: F.NOW });
    expect(result.matchedKeywords).not.toContain('sql');
  });

  // REGRESSION: the static vocabulary had no category for CI/CD, Kubernetes,
  // data-quality tooling, or GenAI/RAG work — all of which the candidate's own
  // technicalStack already lists, and which measured at 10-34% frequency
  // across 20k real stored JDs. These are folded into dataEngineeringStack's
  // existing 12-point/3-match cap (see scorer.js) rather than a new weighted
  // category, so a job built entirely from modern platform-engineering terms
  // can now earn the same credit a classic ETL/Spark/Kafka job always could.
  describe('modern platform-engineering vocabulary (devopsInfra/dataQuality/genAI)', () => {
    it('credits a job that only mentions modern platform terms, not classic ETL ones', () => {
      const job = {
        source: 'greenhouse', company: 'Acme', title: 'Senior Data Engineer',
        jdText: 'Senior Data Engineer. Kubernetes, Docker, Terraform, CI/CD pipelines with GitHub Actions. Strong data quality and observability practices required.',
      };
      const sponsorship = classifySponsorship(job, sponConfig);
      const result = scoreJob(job, { scoring, sponsorship, candidate, now: F.NOW });
      expect(result.breakdown.dataEngineeringStack.points).toBe(result.breakdown.dataEngineeringStack.weight);
      expect(result.matchedKeywords).toEqual(expect.arrayContaining(['kubernetes', 'docker', 'ci/cd']));
    });

    it('credits GenAI/RAG work the candidate profile already lists', () => {
      const job = {
        source: 'greenhouse', company: 'Acme', title: 'Senior Data Engineer',
        jdText: 'Senior Data Engineer building RAG pipelines with LangChain and vector databases on top of an LLM.',
      };
      const sponsorship = classifySponsorship(job, sponConfig);
      const result = scoreJob(job, { scoring, sponsorship, candidate, now: F.NOW });
      expect(result.matchedKeywords).toEqual(expect.arrayContaining(['rag', 'langchain', 'llm']));
    });

    it('credits Tableau under the existing BI category, no new weight bucket', () => {
      const job = {
        source: 'greenhouse', company: 'Acme', title: 'Analytics Engineer',
        jdText: 'Analytics Engineer with strong Tableau dashboarding and semantic modeling experience.',
      };
      const sponsorship = classifySponsorship(job, sponConfig);
      const result = scoreJob(job, { scoring, sponsorship, candidate, now: F.NOW });
      expect(result.matchedKeywords).toContain('tableau');
    });

    it('never widens the total achievable score — same weight, same cap, just a wider matching pool', () => {
      // The point of folding rather than adding a category: nothing here
      // should let a job exceed what dataEngineeringStack always capped at.
      const job = {
        source: 'greenhouse', company: 'Acme', title: 'Senior Data Engineer',
        jdText: 'Kubernetes Docker Terraform CI/CD GitHub Actions Azure DevOps data quality data lineage observability great expectations LLM RAG LangChain LangGraph vector database ETL ELT Spark Kafka Airflow dbt streaming batch processing',
      };
      const sponsorship = classifySponsorship(job, sponConfig);
      const result = scoreJob(job, { scoring, sponsorship, candidate, now: F.NOW });
      expect(result.breakdown.dataEngineeringStack.points).toBeLessThanOrEqual(result.breakdown.dataEngineeringStack.weight);
    });
  });
});

describe('explainScore + sponsorship gate', () => {
  it('assigns Priority/Apply when sponsorship is allowed', () => {
    const sponsorship = classifySponsorship(F.confirmedSponsorship, sponConfig);
    const result = scoreJob(F.confirmedSponsorship, { scoring, sponsorship, candidate, now: F.NOW });
    const { tier } = explainScore(result, scoring);
    expect([TIERS.PRIORITY, TIERS.APPLY]).toContain(tier);
  });

  it('NEVER marks Apply/Priority when sponsorship is Unconfirmed; downgrades to Queue', () => {
    // Force a high score but Unconfirmed sponsorship.
    const result = {
      total: 95, raw: 95, max: 100, breakdown: {}, matchedKeywords: [], missingKeywords: [],
      sponsorship: 'Unconfirmed',
    };
    const { tier, sponsorshipGated } = explainScore(result, scoring);
    expect(tier).toBe(TIERS.QUEUE);
    expect(sponsorshipGated).toBe(true);
  });

  it('allows Apply for Unconfirmed only with explicit user approval', () => {
    const result = { total: 80, sponsorship: 'Unconfirmed', breakdown: {}, matchedKeywords: [], missingKeywords: [] };
    expect(explainScore(result, scoring, { userApproved: true }).tier).toBe(TIERS.APPLY);
  });

  it('rawTier maps thresholds correctly', () => {
    expect(rawTier(90, scoring.tiers)).toBe(TIERS.PRIORITY);
    expect(rawTier(78, scoring.tiers)).toBe(TIERS.APPLY);
    expect(rawTier(65, scoring.tiers)).toBe(TIERS.QUEUE);
    expect(rawTier(55, scoring.tiers)).toBe(TIERS.NEAR_MISS);
    expect(rawTier(20, scoring.tiers)).toBe(TIERS.DISCARD);
  });
});
