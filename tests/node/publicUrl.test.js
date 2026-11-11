import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl, publicOnlyFetch, MAX_REDIRECTS } from '../../src/utils/publicUrl.js';
import { checkJobLink } from '../../src/dashboard/linkHealth.js';

/** A fetch double: `routes` maps a URL to { status, location? }. Records calls. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url] ?? { status: 404 };
    return {
      status: route.status,
      ok: route.status >= 200 && route.status < 300,
      url,
      headers: { get: (name) => (name.toLowerCase() === 'location' ? route.location ?? null : null) },
      body: null,
    };
  };
  return { impl, calls };
}

describe('assertPublicHttpUrl', () => {
  it.each([
    'http://localhost./',
    'http://foo.localhost/',
    'http://jobs.local./',
    'http://intranet.internal../x',
    'http://127.0.0.1./',
  ])('rejects the loopback/internal spelling %s', (url) => {
    expect(assertPublicHttpUrl(url).ok).toBe(false);
  });

  it('still accepts a public fully-qualified name', () => {
    expect(assertPublicHttpUrl('https://boards.greenhouse.io./acme/jobs/1').ok).toBe(true);
  });
});

describe('publicOnlyFetch', () => {
  it('follows public redirects and returns the final response', async () => {
    const { impl, calls } = fakeFetch({
      'https://jobs.example.com/a': { status: 301, location: '/b' },
      'https://jobs.example.com/b': { status: 302, location: 'https://ats.example.com/apply/7' },
      'https://ats.example.com/apply/7': { status: 200 },
    });
    const res = await publicOnlyFetch(impl)('https://jobs.example.com/a');
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      'https://jobs.example.com/a', 'https://jobs.example.com/b', 'https://ats.example.com/apply/7',
    ]);
    // fetch must never follow on its own, or the hop checks are bypassed.
    expect(calls.every((c) => c.init.redirect === 'manual')).toBe(true);
  });

  it('refuses a redirect onto a private address without requesting it', async () => {
    const { impl, calls } = fakeFetch({
      'https://jobs.example.com/a': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
    });
    await expect(publicOnlyFetch(impl)('https://jobs.example.com/a'))
      .rejects.toMatchObject({ code: 'BLOCKED_URL', retryable: false });
    expect(calls).toHaveLength(1);
  });

  it('caps a redirect loop', async () => {
    const { impl, calls } = fakeFetch({
      'https://jobs.example.com/loop': { status: 307, location: '/loop' },
    });
    await expect(publicOnlyFetch(impl)('https://jobs.example.com/loop')).rejects.toThrow(/too many redirects/);
    expect(calls).toHaveLength(MAX_REDIRECTS + 1);
  });

  it('rewrites a POST to GET on 303, as a browser does', async () => {
    const { impl, calls } = fakeFetch({
      'https://jobs.example.com/form': { status: 303, location: '/done' },
      'https://jobs.example.com/done': { status: 200 },
    });
    await publicOnlyFetch(impl)('https://jobs.example.com/form', { method: 'POST', body: 'x' });
    expect(calls[1].init).toMatchObject({ method: 'GET', body: undefined });
  });
});

describe('checkJobLink redirect safety', () => {
  it('refuses a redirect into the local network, never fetching it', async () => {
    const { impl, calls } = fakeFetch({
      'https://jobs.example.com/old': { status: 302, location: 'http://localhost.:4646/api/stats' },
    });
    const result = await checkJobLink('https://jobs.example.com/old', { fetchImpl: impl });
    expect(result.status).toBe('blocked');
    expect(result.message).toMatch(/refused to follow/);
    expect(calls).toHaveLength(1);
  });
});
