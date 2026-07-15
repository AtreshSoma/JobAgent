import { describe, it, expect } from 'vitest';

import {
  deslug, fileToken, candidatePrefix, folderDateOrId, buildJobPaths,
} from '../../src/utils/outputPaths.js';

describe('outputPaths naming convention', () => {
  it('reconstructs readable titles from slugs and preserves acronyms', () => {
    expect(deslug('senior-sql-etl-lead-developer')).toBe('Senior SQL ETL Lead Developer');
    expect(deslug('bi-analyst-developer')).toBe('BI Analyst Developer');
    expect(deslug('data-analytics-engineer-aidp')).toBe('Data Analytics Engineer AIDP');
    expect(deslug('assa-abloy-group')).toBe('Assa Abloy Group');
  });

  it('keeps mixed-case tokens canonical', () => {
    expect(deslug('pyspark-data-engineer')).toBe('PySpark Data Engineer');
    expect(deslug('mlops-platform')).toBe('MLOps Platform');
  });

  it('builds underscore file tokens without stray separators', () => {
    expect(fileToken('Lakebase Sales Specialist - Retail')).toBe('Lakebase_Sales_Specialist_Retail');
    expect(fileToken('Senior SQL/ETL Lead')).toBe('Senior_SQL_ETL_Lead');
    expect(fileToken('Data & Analytics')).toBe('Data_and_Analytics');
  });

  it('derives the candidate filename prefix', () => {
    expect(candidatePrefix('Atresh Somayajula')).toBe('Atresh_Somayajula');
    expect(candidatePrefix()).toBe('Candidate');
  });

  it('normalizes date / id folder suffixes to YYYY-MM-DD when dated', () => {
    expect(folderDateOrId('20260606')).toBe('2026-06-06');
    expect(folderDateOrId('2026-06-07T03:59:22.271Z')).toBe('2026-06-07');
    expect(folderDateOrId('greenhouse-8569436002')).toBe('greenhouse-8569436002');
  });

  it('produces the full professional path set from human metadata', () => {
    const p = buildJobPaths({
      root: '/repo',
      company: 'Databricks',
      title: 'Lakebase Sales Specialist - Retail',
      dateOrId: '20260606',
      candidateName: 'Atresh Somayajula',
    });
    expect(p.companyFolder).toBe('Databricks');
    expect(p.jobFolder).toBe('Lakebase Sales Specialist - Retail_2026-06-06');
    expect(p.resumeDocxPath).toMatch(/Atresh_Somayajula_Resume_Lakebase_Sales_Specialist_Retail\.docx$/);
    expect(p.resumePdfPath).toMatch(/Atresh_Somayajula_Resume_Lakebase_Sales_Specialist_Retail\.pdf$/);
    expect(p.packetName).toBe('Application_Packet_Databricks_Lakebase_Sales_Specialist_Retail.json');
    expect(p.coverLetterPath('txt')).toMatch(/Atresh_Somayajula_Cover_Letter_Lakebase_Sales_Specialist_Retail\.txt$/);
  });

  it('de-slugs company/title when building from a legacy slug', () => {
    const p = buildJobPaths({
      root: '/repo',
      company: 'assa-abloy-group',
      title: 'bi-analyst-developer',
      dateOrId: '20260607',
      fromSlug: true,
    });
    expect(p.companyFolder).toBe('Assa Abloy Group');
    expect(p.jobFolder).toBe('BI Analyst Developer_2026-06-07');
    expect(p.packetName).toBe('Application_Packet_Assa_Abloy_Group_BI_Analyst_Developer.json');
  });
});
