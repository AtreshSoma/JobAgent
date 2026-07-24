import { describe, expect, it } from 'vitest';
import { checkJobLink, classifyJobUrl } from '../../src/dashboard/linkHealth.js';

describe('job link health', () => {
  it('distinguishes aggregator listings from direct employer links', () => {
    expect(classifyJobUrl('https://www.linkedin.com/jobs/view/1').kind).toBe('aggregator');
    expect(classifyJobUrl('https://company.wd5.myworkdayjobs.com/job/1').kind).toBe('direct');
  });

  it('does not mislabel an aggregator 403 as a closed job', async () => {
    const result = await checkJobLink('https://www.linkedin.com/jobs/view/1', {
      fetchImpl: async () => ({ status: 403, url: 'https://www.linkedin.com/jobs/view/1', body: null }),
    });
    expect(result).toMatchObject({ kind: 'aggregator', status: 'restricted', httpStatus: 403 });
    expect(result.message).toContain('may still open');
  });

  it('classifies 404/410 as closed and preserves a successful redirect URL', async () => {
    const closed = await checkJobLink('https://jobs.example.com/old', {
      fetchImpl: async () => ({ status: 410, url: 'https://jobs.example.com/old', body: null }),
    });
    expect(closed.status).toBe('closed');
    const live = await checkJobLink('https://jobs.example.com/old', {
      fetchImpl: async () => ({ status: 200, url: 'https://ats.example.com/apply/7', body: null }),
    });
    expect(live).toMatchObject({ status: 'reachable', finalUrl: 'https://ats.example.com/apply/7' });
  });
});
