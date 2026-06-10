import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  normalizeForAudit,
  auditPresent,
  packetKeywords,
  indexPacketsByResume,
  planRegeneration,
} from '../../scripts/regenerateResumes.js';

const MASTER_TEXT = 'Senior Data Engineer. Built medallion pipelines on Azure Databricks with PySpark and Delta Lake. Power BI semantic models.';

describe('regenerateResumes helpers', () => {
  it('auditPresent keeps only keywords present in the master (case-insensitive)', () => {
    const present = auditPresent(MASTER_TEXT, ['Azure Databricks', 'PySpark', 'Snowflake', 'Redshift']);
    expect(present).toEqual(['Azure Databricks', 'PySpark']);
  });

  it('auditPresent de-dupes and ignores empties', () => {
    const present = auditPresent(MASTER_TEXT, ['pyspark', 'PySpark', '', null]);
    expect(present).toEqual(['pyspark']);
  });

  it('normalizeForAudit collapses whitespace and lowercases', () => {
    expect(normalizeForAudit('  Power   BI  ')).toBe('power bi');
  });

  it('packetKeywords merges matched then missing, de-duped', () => {
    const kws = packetKeywords({
      matchedKeywords: ['python', 'sql'],
      missingKeywords: ['sql', 'scala'],
    });
    expect(kws).toEqual(['python', 'sql', 'scala']);
  });

  it('indexPacketsByResume keeps the packet with the most matched keywords', () => {
    const root = mkdtempSync(join(tmpdir(), 'regen-'));
    const folder = join(root, 'applications', 'output', 'Acme', 'Data Engineer_2026-06-06');
    mkdirSync(folder, { recursive: true });
    const resumePath = join(folder, 'Atresh_Somayajula_Resume_Data_Engineer.docx');
    writeFileSync(resumePath, 'docx');

    writeFileSync(join(folder, 'Application_Packet_Acme_Data_Engineer.json'), JSON.stringify({
      resumePath, job: { company: 'Acme', title: 'Data Engineer' },
      matchedKeywords: ['python'], missingKeywords: ['scala'],
    }));
    writeFileSync(join(folder, 'Application_Packet_Acme_Data_Engineer_v2.json'), JSON.stringify({
      resumePath, job: { company: 'Acme', title: 'Data Engineer' },
      matchedKeywords: ['python', 'sql', 'spark'], missingKeywords: [],
    }));

    const byResume = indexPacketsByResume(root);
    expect(byResume.size).toBe(1);
    const [info] = [...byResume.values()];
    expect(info.matchedCount).toBe(3);
    expect(info.keywords).toEqual(['python', 'sql', 'spark']);
  });

  it('planRegeneration plans resumes with packets and skips those without', () => {
    const root = mkdtempSync(join(tmpdir(), 'regen-'));
    const out = join(root, 'applications', 'output');
    const withPacket = join(out, 'Acme', 'Data Engineer_2026-06-06');
    const orphan = join(out, 'Globex', 'Lead Engineer_2026-06-05');
    mkdirSync(withPacket, { recursive: true });
    mkdirSync(orphan, { recursive: true });

    const resumePath = join(withPacket, 'Atresh_Somayajula_Resume_Data_Engineer.docx');
    writeFileSync(resumePath, 'docx');
    writeFileSync(join(orphan, 'Atresh_Somayajula_Resume_Lead_Engineer.docx'), 'docx');
    writeFileSync(join(withPacket, 'Application_Packet_Acme_Data_Engineer.json'), JSON.stringify({
      resumePath, job: { company: 'Acme', title: 'Data Engineer' },
      matchedKeywords: ['pyspark', 'snowflake'], missingKeywords: [],
    }));

    const byResume = indexPacketsByResume(root);
    const { planned, skipped } = planRegeneration({ root, masterText: MASTER_TEXT, byResume });
    expect(planned).toHaveLength(1);
    expect(planned[0].focusKeywords).toEqual(['pyspark']); // snowflake not in master
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/no packet/);
  });
});
