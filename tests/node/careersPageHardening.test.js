/**
 * careersPage / genericPublicPage hardening.
 *
 * These two adapters point at arbitrary company domains rather than a vendor
 * API, so they are the likeliest in the whole system to meet a host that
 * accepts a connection and then never answers. They used to call `fetchImpl`
 * raw — no request timeout, no host gate, no cancellation — and iterate
 * companies with a sequential `for...of`. That was survivable while the source
 * was disabled with an empty list, and became a real hazard the moment the
 * harvester started proposing companies for it.
 */
import { describe, it, expect, vi } from 'vitest';

import * as careers from '../../src/search/adapters/careersPage.js';
import { fetchUrl } from '../../src/search/adapters/genericPublicPage.js';

const JOB_PAGE = `<!doctype html><html><head><script type="application/ld+json">
${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'JobPosting',
    title: 'Senior Data Engineer', datePosted: '2026-07-30',
    hiringOrganization: { name: 'Acme' },
    jobLocation: { address: { addressLocality: 'Austin', addressRegion: 'TX' } },
    description: '<p>Build pipelines.</p>',
  })}
</script></head><body></body></html>`;

const CAREERS_PAGE = `<html><body>
  <a href="/careers/jobs/1">Senior Data Engineer</a>
  <a href="/careers/jobs/2">Analytics Engineer</a>
</body></html>`;

/** A fetch that never settles unless its AbortSignal fires. */
const hangingFetch = (_url, init = {}) => new Promise((_resolve, reject) => {
  if (!init.signal) return; // no timeout wired -> hangs forever
  init.signal.addEventListener('abort', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    reject(e);
  });
});

describe('genericPublicPage.fetchUrl', () => {
  it('aborts a hung page instead of stalling the run forever', async () => {
    // Without requestTimeoutMs threaded through, this test would time out —
    // which is precisely what a hung careers page used to do to a real run.
    await expect(
      fetchUrl('https://slow.example.com/job/1', {
        fetchImpl: hangingFetch, requestTimeoutMs: 40, maxRetries: 0,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it('identifies the agent rather than impersonating a browser', async () => {
    let seen = null;
    await fetchUrl('https://x.example.com/job/1', {
      fetchImpl: async (_u, init) => { seen = init; return { ok: true, text: async () => JOB_PAGE }; },
      maxRetries: 0,
    });
    const ua = seen.headers['User-Agent'];
    expect(ua).toContain('job-agent');
    expect(ua).not.toMatch(/mozilla|chrome|safari/i);
  });

  it('routes through the host gate when one is supplied', async () => {
    const hostGate = { run: vi.fn((_url, call) => call()), isOpen: () => false };
    await fetchUrl('https://x.example.com/job/1', {
      fetchImpl: async () => ({ ok: true, text: async () => JOB_PAGE }),
      maxRetries: 0, hostGate,
    });
    expect(hostGate.run).toHaveBeenCalledTimes(1);
  });
});

describe('careersPage.run', () => {
  const sitemapFor = (urls) => `<?xml version="1.0"?><urlset>${
    urls.map((u) => `<loc>${u}</loc>`).join('')}</urlset>`;

  it('processes companies in parallel rather than one after another', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => { setTimeout(r, 10); });
      inFlight -= 1;
      return { ok: true, text: async () => JOB_PAGE };
    };
    const companies = Array.from({ length: 6 }, (_, i) => ({
      name: `Co${i}`, sitemap: `https://co${i}.example.com/sitemap.xml`,
    }));

    await careers.run({ companies }, { fetchImpl, boardConcurrency: 4, maxRetries: 0 });
    expect(peak).toBeGreaterThan(1);
  });

  it('aborts a hung careers page instead of hanging the whole source', async () => {
    const { jobs, errors } = await careers.run(
      { companies: [{ name: 'Slow', careersUrl: 'https://slow.example.com/careers' }] },
      { fetchImpl: hangingFetch, requestTimeoutMs: 40, maxRetries: 0 },
    );
    expect(jobs).toEqual([]);
    expect(errors[0].error).toMatch(/timed out/i);
  });

  it('returns cancelled without fetching when the run is cancelled', async () => {
    const fetchImpl = vi.fn();
    const { jobs, cancelled } = await careers.run(
      { companies: [{ name: 'A', careersUrl: 'https://a.example.com/careers' }] },
      { fetchImpl, shouldCancel: () => true, maxRetries: 0 },
    );
    expect(cancelled).toBe(true);
    expect(jobs).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still reports a block honestly rather than retrying around it', async () => {
    const fetchImpl = async () => ({
      ok: false, status: 403, text: async () => 'Access denied',
    });
    const { jobs, errors } = await careers.run(
      { companies: [{ name: 'Walled', careersUrl: 'https://walled.example.com/careers' }] },
      { fetchImpl, maxRetries: 0 },
    );
    expect(jobs).toEqual([]);
    expect(errors[0].error).toContain('blocked');
  });

  it('parses discovered posting links and tags them with the company', async () => {
    const fetchImpl = async (url) => ({
      ok: true,
      text: async () => (String(url).endsWith('/careers') ? CAREERS_PAGE : JOB_PAGE),
    });
    const { jobs } = await careers.run(
      { companies: [{ name: 'Acme', careersUrl: 'https://acme.example.com/careers' }] },
      { fetchImpl, maxRetries: 0 },
    );
    expect(jobs).toHaveLength(2);
    expect(jobs[0].rawMetadata.via).toBe('careers');
    expect(jobs[0].title).toBe('Senior Data Engineer');
  });

  it('delegates ashby and smartrecruiters entries to their official adapters', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ jobs: [], content: [] }), text: async () => '' };
    };
    await careers.run(
      {
        companies: [
          { name: 'Ramp', ats: 'ashby', slug: 'ramp' },
          { name: 'AbbVie', ats: 'smartrecruiters', slug: 'AbbVie' },
        ],
      },
      { fetchImpl, maxRetries: 0 },
    );
    expect(seen.some((u) => u.includes('api.ashbyhq.com/posting-api/job-board/ramp'))).toBe(true);
    expect(seen.some((u) => u.includes('api.smartrecruiters.com/v1/companies/AbbVie'))).toBe(true);
  });

  it('one failing company never denies the others their results', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('broken')) throw new Error('DNS failure');
      return { ok: true, text: async () => (String(url).includes('sitemap') ? sitemapFor(['https://ok.example.com/job/1']) : JOB_PAGE) };
    };
    const { jobs, errors } = await careers.run(
      {
        companies: [
          { name: 'Broken', sitemap: 'https://broken.example.com/sitemap.xml' },
          { name: 'Ok', sitemap: 'https://ok.example.com/sitemap.xml' },
        ],
      },
      { fetchImpl, maxRetries: 0 },
    );
    expect(jobs).toHaveLength(1);
    expect(errors.length).toBeGreaterThan(0);
  });
});
