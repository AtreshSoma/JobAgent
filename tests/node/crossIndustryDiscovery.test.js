/**
 * Cross-industry discovery (2026-11): the sources and the role taxonomy reach
 * beyond tech. Each check here pins something that measurably failed before:
 * The Muse read four fixed tech categories (two of them returning nothing),
 * common pharma/security/Java titles classified below the confidence a family
 * needs, and the employer lists held almost no pharma or security companies.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { MUSE_CATEGORIES_BY_FAMILY, museCategoriesFor, museTitleGate } from '../../src/search/adapters/atsSearch.js';
import { loadRoleFamilies, scoreFamilies, REJECT_CONFIDENCE } from '../../src/profile/roleFamilies.js';
import { PERSONAS } from './fixtures/personas.js';

const boards = JSON.parse(readFileSync(new URL('../../config/jobboards.json', import.meta.url), 'utf8'));
const sources = Array.isArray(boards.sources) ? boards.sources : Object.values(boards.sources);
const source = (id) => sources.find((s) => s.id === id);

/** Every Muse category name confirmed against the live endpoint (2026-11-01). */
const VERIFIED_MUSE = new Set([
  'Data and Analytics', 'Software Engineering', 'Computer and IT', 'Product Management', 'Project Management',
  'Design and UX', 'Advertising and Marketing', 'Sales', 'Account Management', 'Accounting and Finance',
  'Legal Services', 'Science and Engineering', 'Healthcare', 'Human Resources and Recruitment',
  'Business Operations', 'Customer Service', 'Education', 'Manufacturing and Warehouse',
  'Installation, Maintenance, and Repairs', 'Construction', 'Transportation and Logistics',
  'Food and Hospitality Services', 'Retail', 'Protective Services', 'Media, PR, and Communications',
  'Writing and Editing', 'Administration and Office', 'Personal Care and Services', 'Sports, Fitness, and Recreation',
]);

const candidateOf = (persona) => ({
  targetTitles: persona.searchIntent.targetRoles,
  technicalStack: { core: persona.background.skills },
  domainExperience: persona.background.industries,
});

describe('The Muse categories follow the profile', () => {
  it('maps every role family, using only category names that exist', () => {
    const families = Object.keys(loadRoleFamilies().families);
    for (const id of families) {
      expect(MUSE_CATEGORIES_BY_FAMILY[id], `no Muse mapping for ${id}`).toBeTruthy();
      for (const category of MUSE_CATEGORIES_BY_FAMILY[id]) expect(VERIFIED_MUSE.has(category), category).toBe(true);
    }
    // The names that silently return nothing must never come back.
    const all = Object.values(MUSE_CATEGORIES_BY_FAMILY).flat();
    for (const dead of ['IT', 'Data Science', 'Cybersecurity', 'Pharmacy', 'Nurses', 'Marketing']) expect(all).not.toContain(dead);
  });

  it.each([
    ['pv', ['Science and Engineering', 'Healthcare']],
    ['cyber', ['Computer and IT']],
    ['javafs', ['Software Engineering']],
    ['nurse', ['Healthcare']],
    ['accountant', ['Accounting and Finance']],
    ['electrician', ['Installation, Maintenance, and Repairs']],
  ])('reads the right categories for the %s persona', (id, expected) => {
    const categories = museCategoriesFor(candidateOf(PERSONAS.find((p) => p.id === id)));
    for (const category of expected) expect(categories).toContain(category);
    expect(categories.length).toBeLessThanOrEqual(6);
  });

  it('honours an explicit override and falls back to verified defaults without a profile', () => {
    expect(museCategoriesFor({}, { museCategories: ['Healthcare'] })).toEqual(['Healthcare']);
    const fallback = museCategoriesFor(null);
    expect(fallback.length).toBeGreaterThan(0);
    for (const category of fallback) expect(VERIFIED_MUSE.has(category)).toBe(true);
  });

  it('no longer pins a fixed category list in config', () => {
    expect(source('ats-search').options.museCategories).toBeUndefined();
  });
});

describe('The Muse keeps only positive title matches (it has no search text)', () => {
  // Titles the live endpoint returned for these profiles on 2026-11-01.
  it.each([
    ['pv', ['Pharmacovigilance Scientist', 'Senior Drug Safety Scientist'], ['Cost Engineer', 'Piping Field Engineer - Underground']],
    ['cyber', ['Cybersecurity Analyst', 'SOC Analyst II', 'Information Security Engineer'],
      ['IT Support Technician, VIP Support', 'Relief Weekend or Weekday Veterinarians', 'Equity Research Analyst/Associate']],
  ])('%s', (id, keep, drop) => {
    const gate = museTitleGate({ candidate: candidateOf(PERSONAS.find((p) => p.id === id)) }, {});
    for (const title of keep) expect(gate(title), title).toBe(true);
    for (const title of drop) expect(gate(title), title).toBe(false);
  });

  it('falls back to the shared gate when disabled or without a profile', () => {
    const shared = () => 'shared';
    expect(museTitleGate({}, {}, shared)).toBe(shared);
    expect(museTitleGate({ candidate: candidateOf(PERSONAS[0]) }, { museRequireTitleMatch: false }, shared)).toBe(shared);
  });
});

describe('common titles in these fields classify with confidence', () => {
  const taxonomy = loadRoleFamilies();
  it.each([
    ['Pharmacovigilance Scientist', 'regulatory-quality'],
    ['Drug Safety Associate', 'regulatory-quality'],
    ['Medical Science Liaison', 'science-research'],
    ['Cybersecurity Analyst', 'security'],
    ['Cloud Security Engineer', 'security'],
    ['Java Developer', 'software-engineering'],
    ['Full Stack Java Developer', 'software-engineering'],
  ])('%s → %s', (title, family) => {
    const [top] = scoreFamilies(title, taxonomy);
    expect(top?.id).toBe(family);
    expect(top.score).toBeGreaterThanOrEqual(REJECT_CONFIDENCE);
  });

  it('leaves the existing classifications alone', () => {
    expect(scoreFamilies('Registered Nurse', taxonomy)[0].id).toBe('healthcare-clinical');
    expect(scoreFamilies('Senior Data Engineer', taxonomy)[0].id).toBe('data-analytics');
    expect(scoreFamilies('Accounts Payable Administrator', taxonomy)[0].id).toBe('finance-accounting');
  });
});

describe('employer lists reach pharma and security', () => {
  it('includes verified pharma, CRO and medtech Workday tenants', () => {
    const tenants = new Set(source('workday-public').tenants.map((t) => t.company));
    for (const company of ['Johnson & Johnson', 'Merck', 'AstraZeneca', 'Novartis', 'Amgen', 'IQVIA', 'Thermo Fisher Scientific', 'Pfizer']) {
      expect(tenants.has(company), company).toBe(true);
    }
  });

  it('includes verified security employers', () => {
    const gh = new Set(source('greenhouse-boards').boards);
    for (const token of ['cloudflare', 'sentinellabs', 'zscaler', 'wizinc', 'netskope']) expect(gh.has(token), token).toBe(true);
    const tenants = new Set(source('workday-public').tenants.map((t) => t.company));
    for (const company of ['CrowdStrike', 'Northrop Grumman', 'Leidos']) expect(tenants.has(company), company).toBe(true);
  });

  it('has no duplicate tenants or boards', () => {
    const t = source('workday-public').tenants.map((x) => `${x.host}/${x.tenant}/${x.site}`.toLowerCase());
    expect(new Set(t).size).toBe(t.length);
    const g = source('greenhouse-boards').boards.map((x) => x.toLowerCase());
    expect(new Set(g).size).toBe(g.length);
  });
});
