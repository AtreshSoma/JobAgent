import { describe, it, expect } from 'vitest';
import {
  normalizeText,
  normalizeLoose,
  slugify,
  containsPhrase,
  matchedPhrases,
  dedupKey,
} from '../../src/utils/textNormalize.js';

describe('textNormalize', () => {
  it('normalizeText lowercases, collapses whitespace, trims', () => {
    expect(normalizeText('  Senior   DATA  Engineer ')).toBe('senior data engineer');
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
  });

  it('normalizeLoose strips punctuation to alphanumeric tokens', () => {
    expect(normalizeLoose('Sr. Data-Engineer (Remote)!')).toBe('sr data engineer remote');
  });

  it('slugify produces filesystem-safe slugs with a cap', () => {
    expect(slugify('Contoso (Fabrikam)')).toBe('contoso_fabrikam');
    expect(slugify('Senior Data Engineer', 10)).toBe('senior_dat');
    expect(slugify('')).toBe('untitled');
  });

  it('containsPhrase is case-insensitive', () => {
    expect(containsPhrase('We do NOT offer sponsorship', 'no offer sponsorship')).toBe(false);
    expect(containsPhrase('US Citizens Only', 'us citizens only')).toBe(true);
    expect(containsPhrase('anything', '')).toBe(false);
  });

  it('matchedPhrases returns matching phrases preserving original casing', () => {
    const text = 'Requires Azure Databricks and PySpark experience';
    const phrases = ['Azure', 'pyspark', 'snowflake'];
    expect(matchedPhrases(text, phrases)).toEqual(['Azure', 'pyspark']);
    expect(matchedPhrases('', phrases)).toEqual([]);
  });

  // REGRESSION: matching used to be plain substring containment, which
  // silently credited a short acronym keyword whenever it happened to appear
  // inside an unrelated, longer word. Verified live against real postings
  // before this fix — a "NoSQL databases" JD (explicitly NOT a SQL role)
  // registered "sql" as matched, and "elt" (Extract-Load-Transform) matched
  // inside plain English "felt"/"belt". `tailor.py`'s `_phrase_pattern`
  // already solved this on the resume side; this ports the identical
  // boundary rule to JS so scoring and tailoring can no longer disagree.
  describe('boundary-aware matching (regression: short-keyword false positives)', () => {
    it('does not credit "sql" for a NoSQL-only posting', () => {
      expect(containsPhrase('Experience with NoSQL databases like MongoDB', 'sql')).toBe(false);
    });

    it('does not credit "elt" inside ordinary English words', () => {
      expect(containsPhrase('Team members felt the deadline was tight', 'elt')).toBe(false);
      expect(containsPhrase('experience with conveyor belt systems', 'elt')).toBe(false);
    });

    it('still credits the same short keywords when they genuinely appear', () => {
      expect(containsPhrase('Strong SQL and Python skills required', 'sql')).toBe(true);
      expect(containsPhrase('Built ELT pipelines in dbt', 'elt')).toBe(true);
      expect(containsPhrase('5 years of ETL/ELT development', 'elt')).toBe(true);
    });

    it('does not let "java" hide inside "javascript"', () => {
      expect(containsPhrase('Strong JavaScript and React skills', 'java')).toBe(false);
      expect(containsPhrase('5 years of Java backend development', 'java')).toBe(true);
    });

    it('still matches phrases containing tech punctuation at their true edges', () => {
      // The boundary is [a-z0-9], not \b — so hyphens/slashes act as boundaries
      // on both sides, and a phrase built from them still matches correctly.
      expect(containsPhrase('5+ years of T-SQL experience', 't-sql')).toBe(true);
      expect(containsPhrase('Strong CI/CD pipelines', 'ci/cd')).toBe(true);
      expect(containsPhrase('Power BI and DAX required', 'power bi')).toBe(true);
    });

    it('applies the same fix to matchedPhrases, used by scoring and exclusion filters alike', () => {
      const text = 'NoSQL and MongoDB experience; team felt strongly about it';
      expect(matchedPhrases(text, ['sql', 'elt', 'mongodb'])).toEqual(['mongodb']);
    });
  });

  it('dedupKey builds a stable key from company+title+id', () => {
    const a = dedupKey({ company: 'Acme Corp.', title: 'Sr. Data Engineer', sourceJobId: 'X1' });
    const b = dedupKey({ company: 'ACME  CORP', title: 'sr data  engineer', sourceJobId: 'x1' });
    expect(a).toBe(b);
    expect(dedupKey({ company: 'Acme', title: 'Engineer' })).toBe('acme::engineer');
  });
});
