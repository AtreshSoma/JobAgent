/**
 * ATS platform detection.
 *
 * Identifies which Applicant Tracking System hosts a job/application URL using
 * structural host/markup signals only (no scraping, no evasion). Returns the
 * platform key used to pick a form-prep adapter under ./platforms.
 */

/** host substring / html signal -> platform key. */
const SIGNATURES = [
  { key: 'greenhouse', hosts: ['greenhouse.io', 'boards.greenhouse.io'], html: ['greenhouse.io', 'gh_jid'] },
  { key: 'lever', hosts: ['lever.co', 'jobs.lever.co'], html: ['lever.co', 'postings.lever'] },
  { key: 'ashby', hosts: ['ashbyhq.com', 'jobs.ashbyhq.com'], html: ['ashbyhq', 'ashby-job-posting'] },
  { key: 'workday', hosts: ['myworkdayjobs.com', 'workday.com'], html: ['workday', 'wd1.myworkdayjobs'] },
  { key: 'icims', hosts: ['icims.com'], html: ['icims'] },
  { key: 'taleo', hosts: ['taleo.net'], html: ['taleo'] },
  { key: 'smartrecruiters', hosts: ['smartrecruiters.com'], html: ['smartrecruiters'] },
  { key: 'jobvite', hosts: ['jobvite.com'], html: ['jobvite'] },
];

/**
 * @param {object} input
 * @param {string} [input.url]
 * @param {string} [input.html]
 * @returns {{ platform: string, confidence: number, signal: string|null }}
 */
export function detectAts({ url = '', html = '' } = {}) {
  const host = safeHost(url);
  // Greenhouse's embed hands its job id to the HOST page as `?gh_jid=` —
  // careers.company.com/jobs?gh_jid=123 is a Greenhouse application on a
  // non-Greenhouse host, and was detected as `generic` (so the fixture-tested
  // Greenhouse contract and its selectors were never used for it).
  if (hasQueryParam(url, 'gh_jid')) {
    return { platform: 'greenhouse', confidence: 0.9, signal: 'query:gh_jid' };
  }
  for (const sig of SIGNATURES) {
    if (host && sig.hosts.some((h) => host.includes(h))) {
      return { platform: sig.key, confidence: 1, signal: `host:${host}` };
    }
  }
  const lowerHtml = (html ?? '').toLowerCase();
  for (const sig of SIGNATURES) {
    const hit = sig.html.find((token) => lowerHtml.includes(token));
    if (hit) return { platform: sig.key, confidence: 0.6, signal: `html:${hit}` };
  }
  return { platform: 'generic', confidence: 0, signal: null };
}

function hasQueryParam(url, name) {
  try {
    return new URL(url).searchParams.has(name);
  } catch {
    return false;
  }
}

function safeHost(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

export const KNOWN_PLATFORMS = SIGNATURES.map((s) => s.key).concat('generic');
