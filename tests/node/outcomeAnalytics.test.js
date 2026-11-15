/**
 * Outcome analytics (audit F9).
 *
 * "What gets interviews" already broke submitted applications down by source,
 * application system, score band, tier and days-to-apply. F9 adds role family
 * and resume (tailored or master), and offer rates beside interview rates. The
 * same rule holds everywhere: a group too small to mean anything shows counts
 * and no percentage.
 */
import { describe, expect, it } from 'vitest';

import { conversionBreakdown } from '../../src/domain/applicationOutcome.js';

import { conversionText } from '../../src/dashboard/public/assets/js/conversionText.js';

const sent = (over) => ({ appStatus: 'submitted', reached: null, source: 'greenhouse', tier: 'Priority', score: 80, ...over });

describe('conversionBreakdown, new groups', () => {
  const items = [
    ...Array.from({ length: 6 }, (_, i) => sent({ roleFamily: 'Data engineering', resumeKind: 'Tailored resume', reached: i < 3 ? 'interviewing' : null })),
    ...Array.from({ length: 5 }, (_, i) => sent({ roleFamily: 'Data engineering', resumeKind: 'Tailored resume', reached: i < 2 ? 'offer' : 'interviewing' })),
    ...Array.from({ length: 2 }, () => sent({ roleFamily: 'Analytics', resumeKind: 'Master resume' })),
    sent({ roleFamily: null, resumeKind: 'Master resume', appStatus: 'approved' }),
  ];
  const c = conversionBreakdown(items);

  it('groups by role family and by resume, submitted applications only', () => {
    expect(c.roleFamily.map((r) => [r.key, r.submitted])).toEqual([['Data engineering', 11], ['Analytics', 2]]);
    expect(c.resume.map((r) => [r.key, r.submitted])).toEqual([['Tailored resume', 11], ['Master resume', 2]]);
  });

  it('gives an offer rate out of interviews, only when there are enough interviews', () => {
    const de = c.roleFamily.find((r) => r.key === 'Data engineering');
    expect(de).toMatchObject({ interviews: 8, offers: 2, interviewRate: 73, offerRate: 25 });
    const an = c.roleFamily.find((r) => r.key === 'Analytics');
    expect(an).toMatchObject({ tooFew: true, interviewRate: null, offerRate: null });
  });

  it('keeps the groups it had', () => {
    for (const dim of ['source', 'ats', 'scoreBand', 'tier', 'applySpeed']) expect(Array.isArray(c[dim])).toBe(true);
  });
});

describe('conversionText', () => {
  it('adds the offer rate when there is one', () => {
    expect(conversionText({ submitted: 11, interviews: 8, offers: 2, interviewRate: 73, offerRate: 25, tooFew: false }))
      .toBe('8 of 11 reached an interview (73%); 2 of 8 interviews became an offer (25%)');
  });
  it('says too few, as before', () => {
    expect(conversionText({ submitted: 2, interviews: 0, offers: 0, tooFew: true })).toMatch(/too few to tell/);
  });
});
