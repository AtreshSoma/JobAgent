/**
 * Cover letters and packets must never carry template text to an employer.
 *
 * Regression: when any sentence of a template needed a fact the profile did
 * not state, `fill()` dropped that sentence and returned the KEPT sentences
 * without substituting them, so a letter written to disk read
 * "I am applying for the {title} role at {company}."
 */
import { describe, it, expect } from 'vitest';

import { generateCoverLetter } from '../../src/apply/coverLetter.js';
import { buildApplicationPacket } from '../../src/apply/applicationPacket.js';
import {
  candidatePlaceholders, findTemplateTokens, assertNoTemplateTokens, valuesAtPath,
} from '../../src/config/placeholders.js';

const coverLetter = {
  enabled: true,
  minScoreToGenerate: 0,
  wordCount: { min: 0, max: 400 },
  greeting: 'Dear {company} team,',
  closing: 'Sincerely,',
  includeSponsorshipNote: false,
  template: {
    // The second sentence needs {years}; the profile below does not state it.
    opening: 'I am applying for the {title} role at {company}. As a {headline} with {years} of experience, I fit.',
    skillsLead: 'Strengths:',
    experience: 'In my current role I {topHighlight}.',
    fitNote: 'I focus on {focusAreas}.',
    closingParagraph: 'I would welcome the chance to contribute to {company}.',
  },
};
const candidate = {
  identity: { fullName: 'Priya Raghunathan', headline: 'Data Engineer' },
  workHistory: [{ highlights: [] }],
  technicalStack: {},
};
const job = { title: 'Senior Data Engineer', company: 'Acme Analytics' };

describe('cover letter template filling', () => {
  it('substitutes the sentences it keeps when another sentence is dropped', () => {
    const r = generateCoverLetter(job, { total: 90, matchedKeywords: [] }, { coverLetter, candidate, humanizerPatterns: {} });
    expect(r.generated).toBe(true);
    expect(r.text).toContain('I am applying for the Senior Data Engineer role at Acme Analytics.');
    expect(r.text).toContain('Dear Acme Analytics team,');
    // The {years} sentence is omitted, never filled with a guess.
    expect(r.text).not.toMatch(/of experience/);
    expect(findTemplateTokens(r.text)).toEqual([]);
  });

  it('refuses a letter an injected composer left with tokens in it', () => {
    expect(() => generateCoverLetter(job, { total: 90 }, {
      coverLetter, candidate, humanizerPatterns: {}, compose: () => 'Hello {hiringManager}, I like {company}.',
    })).toThrow(/unfilled template placeholder\(s\) \{hiringManager\}, \{company\}/);
  });
});

describe('packet chokepoint', () => {
  it('refuses a packet whose cover letter or planned answer still has a {token}', () => {
    const base = {
      job: { id: 'j1', url: 'https://boards.greenhouse.io/acme/jobs/1', company: 'Acme', title: 'DE' },
      candidate, screeningAnswers: { answers: [] },
    };
    expect(() => buildApplicationPacket({
      ...base, coverLetter: { generated: true, text: 'I am applying for {title}.' },
    })).toThrow(/cover letter.*\{title\}/);
    expect(() => buildApplicationPacket({
      ...base,
      formFields: [{ label: 'Why us?', selector: '#why' }],
      screeningAnswers: { answers: [{ id: 'why', patterns: ['why us'], answer: 'Because {company} rocks.' }] },
    })).toThrow(/answer for "Why us\?".*\{company\}/);
  });
});

describe('placeholder guard covers career facts', () => {
  it('catches the shipped example work history and education', () => {
    const found = candidatePlaceholders({
      workHistory: [
        { employer: 'Real Employer LLC', highlights: ['Cut batch runtime 40%'] },
        { employer: 'Example Corp', highlights: ['Shipped X', 'One-line, metric-backed achievement bullet'] },
      ],
      education: [{ institution: 'Example University' }],
    });
    expect(found.map((f) => f.path)).toEqual([
      'workHistory[1].highlights[1]',
      'workHistory[1].employer',
      'education[0].institution',
    ]);
  });

  it('expands wildcards and array leaves', () => {
    expect(valuesAtPath({ a: [{ b: ['x', 'y'] }, { b: 'z' }] }, 'a[*].b')).toEqual([
      { path: 'a[0].b[0]', value: 'x' }, { path: 'a[0].b[1]', value: 'y' }, { path: 'a[1].b', value: 'z' },
    ]);
    expect(valuesAtPath({}, 'a[*].b')).toEqual([]);
  });

  it('assertNoTemplateTokens passes ordinary braces-free text', () => {
    expect(() => assertNoTemplateTokens('Dear team, thanks.')).not.toThrow();
  });
});
