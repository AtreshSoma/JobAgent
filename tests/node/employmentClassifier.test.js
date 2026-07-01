import { describe, it, expect } from 'vitest';

import { classifyEmployment, EMPLOYMENT_LABELS } from '../../src/scoring/employmentClassifier.js';

// Mirrors the shape of config/exclusions.json -> employmentTypes.
const MARKERS = {
  defaultToFullTime: true,
  contractToHire: ['contract to hire', 'temp to perm'],
  contract: ['contract position', 'contract role', 'w2 contract', 'c2c', 'corp to corp', 'month contract'],
  partTime: ['part time', 'part-time'],
  fullTime: ['full time', 'full-time', 'permanent', 'direct hire'],
};

describe('classifyEmployment', () => {
  it('detects contract from the employmentType field', () => {
    const r = classifyEmployment({ employmentType: 'Contract', title: 'Data Engineer', jdText: '' }, MARKERS);
    // "Contract" alone is not a configured multi-word phrase; the JD/title decide.
    expect(r.category).toBe('full_time');
  });

  it('detects contract from a multi-word title/JD phrase', () => {
    expect(classifyEmployment({ title: 'Data Engineer (Contract Position)', jdText: '' }, MARKERS).category)
      .toBe('contract');
    expect(classifyEmployment({ title: 'Data Engineer', jdText: 'This is a 6 month contract via W2.' }, MARKERS).category)
      .toBe('contract');
    expect(classifyEmployment({ title: 'Data Engineer', employmentType: 'C2C', jdText: '' }, MARKERS).category)
      .toBe('contract');
  });

  it('prefers contract_to_hire over contract when both could match', () => {
    const r = classifyEmployment({ title: 'Data Engineer — Contract to hire', jdText: 'contract position' }, MARKERS);
    expect(r.category).toBe('contract_to_hire');
  });

  it('detects part-time', () => {
    expect(classifyEmployment({ title: 'Part-time Data Analyst', jdText: '' }, MARKERS).category)
      .toBe('part_time');
  });

  it('reports a flexible "Full Time/Part Time" role as full_time (full-time available)', () => {
    const r = classifyEmployment({ employmentType: 'Full Time/Part Time', title: 'Operations Supervisor', jdText: '' }, MARKERS);
    expect(r.category).toBe('full_time');
  });

  it('does NOT mis-tag a "data contract" mention as a contract role', () => {
    const jd = 'Own data contracts and schema enforcement across the platform. Permanent role.';
    expect(classifyEmployment({ title: 'Senior Data Engineer', jdText: jd }, MARKERS).category)
      .toBe('full_time');
  });

  it('defaults to full_time when no signal and defaultToFullTime is on', () => {
    expect(classifyEmployment({ title: 'Data Engineer', jdText: 'Build pipelines.' }, MARKERS).category)
      .toBe('full_time');
  });

  it('returns unknown when no signal and defaultToFullTime is off', () => {
    const markers = { ...MARKERS, defaultToFullTime: false };
    expect(classifyEmployment({ title: 'Data Engineer', jdText: 'Build pipelines.' }, markers).category)
      .toBe('unknown');
  });

  it('only asserts full_time from the reliable primary text, not JD boilerplate', () => {
    // "full-time" appears only in the JD body; with defaults off that is not
    // enough to assert full_time.
    const markers = { ...MARKERS, defaultToFullTime: false };
    const r = classifyEmployment({ title: 'Data Engineer', jdText: 'This is a full-time opportunity.' }, markers);
    expect(r.category).toBe('unknown');
  });

  it('is safe with empty markers and empty job', () => {
    expect(classifyEmployment().category).toBe('full_time');
    expect(classifyEmployment({}, {}).category).toBe('full_time');
  });

  it('exposes human labels for every category', () => {
    expect(EMPLOYMENT_LABELS.full_time).toBe('Full-time');
    expect(EMPLOYMENT_LABELS.contract).toBe('Contract');
    expect(EMPLOYMENT_LABELS.contract_to_hire).toBe('Contract-to-hire');
    expect(EMPLOYMENT_LABELS.part_time).toBe('Part-time');
  });
});
