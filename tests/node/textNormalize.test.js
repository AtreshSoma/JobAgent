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
    expect(slugify('Microsoft (Capgemini)')).toBe('microsoft_capgemini');
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

  it('dedupKey builds a stable key from company+title+id', () => {
    const a = dedupKey({ company: 'Acme Corp.', title: 'Sr. Data Engineer', sourceJobId: 'X1' });
    const b = dedupKey({ company: 'ACME  CORP', title: 'sr data  engineer', sourceJobId: 'x1' });
    expect(a).toBe(b);
    expect(dedupKey({ company: 'Acme', title: 'Engineer' })).toBe('acme::engineer');
  });
});
