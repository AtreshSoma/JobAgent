/**
 * Shared sample jobs for filtering/scoring tests.
 * These are synthetic JDs, not real postings.
 */
import { normalizeJob } from '../../../src/search/normalize.js';

const recent = '2026-06-01T00:00:00Z'; // a few days before the 2026-06-04 test date

export const azureFabricSenior = normalizeJob({
  source: 'greenhouse',
  company: 'Acme Analytics',
  title: 'Senior Data Engineer',
  location: 'Remote, US',
  sourceJobId: 'AF-1',
  postedAt: recent,
  applicantCount: 12,
  employmentType: 'Full-time',
  jdText: 'Senior Data Engineer to build medallion lakehouses on Azure Databricks and ' +
    'Microsoft Fabric. Delta Lake, ADF, Synapse, PySpark, Python, SQL, Power BI semantic models. ' +
    'Finance domain. Visa sponsorship available for the right candidate.',
});

export const confirmedSponsorship = normalizeJob({
  source: 'lever',
  company: 'Globex',
  title: 'Lead Data Engineer',
  location: 'Remote, US',
  sourceJobId: 'CS-1',
  postedAt: recent,
  applicantCount: 30,
  jdText: 'Lead Data Engineer building lakehouse data pipelines on Azure Databricks and ' +
    'Microsoft Fabric. Delta Lake, ADF, Synapse, ETL/ELT, PySpark, Python, SQL, T-SQL. ' +
    'Power BI semantic models and DAX. Finance domain. We sponsor H-1B visas.',
});

export const noSponsorship = normalizeJob({
  source: 'manual',
  company: 'Initech',
  title: 'Senior Data Engineer',
  location: 'Austin, TX',
  sourceJobId: 'NS-1',
  postedAt: recent,
  jdText: 'Azure data engineer. US citizens only; we are unable to sponsor visas.',
});

export const clearanceRequired = normalizeJob({
  source: 'manual',
  company: 'Defense Co',
  title: 'Data Engineer',
  location: 'Reston, VA',
  sourceJobId: 'CL-1',
  postedAt: recent,
  jdText: 'Data Engineer supporting DoD programs. Active Top Secret clearance required.',
});

export const snowflakeMismatch = normalizeJob({
  source: 'manual',
  company: 'DataCo',
  title: 'Senior Data Engineer',
  location: 'Remote, US',
  sourceJobId: 'SM-1',
  postedAt: recent,
  jdText: 'Snowflake and dbt shop. Looking for ELT on Snowflake with Fivetran. No Azure.',
});

export const juniorRole = normalizeJob({
  source: 'manual',
  company: 'StartCo',
  title: 'Junior Data Engineer',
  location: 'Remote, US',
  sourceJobId: 'JR-1',
  postedAt: recent,
  jdText: 'Entry level / junior data engineer. Great first role. SQL and Python basics.',
});

export const staleHighApplicants = normalizeJob({
  source: 'manual',
  company: 'OldCo',
  title: 'Senior Data Engineer',
  location: 'Remote, US',
  sourceJobId: 'ST-1',
  postedAt: '2026-05-01T00:00:00Z', // > 14 days before 2026-06-04
  applicantCount: 350,
  jdText: 'Azure Databricks senior data engineer. PySpark, SQL.',
});

export const duplicatePair = [
  normalizeJob({ source: 'greenhouse', company: 'Acme', title: 'Senior Data Engineer', sourceJobId: 'D1', jdText: 'short' }),
  normalizeJob({ source: 'lever', company: 'ACME', title: 'senior data engineer', sourceJobId: 'D1', jdText: 'a longer more detailed jd about azure and pyspark' }),
];

export const NOW = new Date('2026-06-04T00:00:00Z');
