/**
 * ATS platform registry — the single source of truth for "what platform is this
 * careers site, and can we enumerate it?"
 *
 * WHY THIS EXISTS. Coverage grows by PLATFORM, not by company. iCIMS alone hosts
 * ~6,400 employers and Workday tens of thousands, so a per-company scraper is
 * the wrong unit of work: one platform adapter plus a way to recognize the
 * platform reaches every employer on it. This module is the recognizer. It is
 * pure data plus small pure functions — no I/O — so it can be used equally by
 * the harvester (which reads URLs already in the database), by a future
 * "point me at a careers page" command, and by tests.
 *
 * Each entry declares:
 *   id            adapter id that can enumerate it, or a label when none can
 *   label         human name for reports
 *   hostPattern   regex against the URL hostname — the cheapest signal
 *   pathHint      optional regex the URL path must also match, for hosts that
 *                 serve more than the ATS (oraclecloud.com serves all of Oracle
 *                 Cloud, not only recruiting)
 *   bodyMarkers   literal strings that appear in the HTML of a site on this
 *                 platform. These are what identify a company that fronts its
 *                 ATS behind its OWN domain, which hostname matching cannot see.
 *   extract       (url) => coordinate object the config/adapters understand
 *   enumerable    true when this codebase can actually list jobs from it
 *   note          when not enumerable, the verified reason
 *
 * EVERY signature here was confirmed against live sites; none is guessed. The
 * `enumerable: false` entries are as valuable as the others — they record what
 * was checked and why it failed, so the same dead end is not re-explored.
 */

/** Path segments that are never a company slug. */
const NON_SLUG = new Set([
  'search', 'jobs', 'job', 'careers', 'career', 'embed', 'api', 'static',
  'assets', 'about', 'login', 'signin', 'apply', 'company', 'companies',
  'view', 'privacy', 'terms', 'sitemap', 'index',
]);

const LOCALE_RE = /^[a-z]{2}(-[A-Za-z]{2})?$/;

/** Build a `{ ats, slug }` coordinate, rejecting non-slug path segments. */
function slugCoordinate(ats, raw) {
  const slug = String(raw ?? '').trim();
  if (!slug || NON_SLUG.has(slug.toLowerCase()) || slug.includes('.')) return null;
  return { ats, slug };
}

const segmentsOf = (u) => u.pathname.split('/').filter(Boolean);

/**
 * The registry. Order matters only in that the first match wins, so more
 * specific host patterns precede broader ones.
 */
export const PLATFORMS = Object.freeze([
  {
    id: 'greenhouse',
    label: 'Greenhouse',
    hostPattern: /(^|\.)greenhouse\.io$/,
    bodyMarkers: ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'greenhouse.io/embed'],
    enumerable: true,
    extract: (u) => slugCoordinate('greenhouse', u.searchParams.get('for') || segmentsOf(u)[0]),
  },
  {
    id: 'lever',
    label: 'Lever',
    hostPattern: /(^|\.)lever\.co$/,
    bodyMarkers: ['jobs.lever.co'],
    enumerable: true,
    extract: (u) => slugCoordinate('lever', segmentsOf(u)[0]),
  },
  {
    id: 'ashby',
    label: 'Ashby',
    hostPattern: /(^|\.)ashbyhq\.com$/,
    bodyMarkers: ['jobs.ashbyhq.com'],
    enumerable: true,
    extract: (u) => slugCoordinate('ashby', segmentsOf(u)[0]),
  },
  {
    id: 'smartrecruiters',
    label: 'SmartRecruiters',
    hostPattern: /(^|\.)smartrecruiters\.com$/,
    bodyMarkers: ['jobs.smartrecruiters.com'],
    enumerable: true,
    extract: (u) => {
      const segs = segmentsOf(u);
      if (u.hostname.toLowerCase().startsWith('api.')) {
        const i = segs.indexOf('companies');
        return i === -1 ? null : slugCoordinate('smartrecruiters', segs[i + 1]);
      }
      return slugCoordinate('smartrecruiters', segs[0]);
    },
  },
  {
    id: 'workday',
    label: 'Workday',
    hostPattern: /\.myworkdayjobs\.com$/,
    bodyMarkers: ['myworkdayjobs.com', '/wday/cxs/'],
    enumerable: true,
    extract: (u) => {
      const host = u.hostname.toLowerCase();
      const segs = segmentsOf(u);
      const tenant = host.split('.')[0];
      if (!tenant) return null;
      // The site name is the segment before `/job/` — the only position Workday
      // guarantees. Falling back to "last segment" would harvest a job title as
      // a site name, so a URL with no marker is skipped rather than guessed at.
      const jobIndex = segs.indexOf('job');
      let site = null;
      if (jobIndex > 0) site = segs[jobIndex - 1];
      else if (segs.length === 1 && !LOCALE_RE.test(segs[0])) site = segs[0];
      else if (segs.length === 2 && LOCALE_RE.test(segs[0])) site = segs[1];
      if (!site || LOCALE_RE.test(site) || NON_SLUG.has(site.toLowerCase())) return null;
      return { ats: 'workday', host, tenant, site };
    },
  },
  {
    id: 'oracleRecruiting',
    label: 'Oracle Fusion Recruiting Cloud',
    hostPattern: /(^|\.)oraclecloud\.com$/,
    // oraclecloud.com serves all of Oracle Cloud; only the CandidateExperience
    // path is recruiting, so the host alone must not classify a site.
    pathHint: /\/(hcmUI\/CandidateExperience|hcmRestApi)\//i,
    // Oracle Recruiting also runs on employers' OWN domains: Dell's careers
    // site redirects to enterpriseplatform.dell.com/hcmUI/CandidateExperience/
    // (site CX_1001), and the same REST API answers there (verified 2026-11-20).
    // The path is distinctive enough to classify any host.
    vanityPath: /\/hcmUI\/CandidateExperience\//i,
    bodyMarkers: ['/hcmUI/CandidateExperience/', 'recruitingCEJobRequisitions'],
    enumerable: true,
    extract: (u) => {
      const segs = segmentsOf(u);
      const i = segs.indexOf('sites');
      if (i === -1) return null;
      const siteNumber = segs[i + 1];
      if (!siteNumber || NON_SLUG.has(String(siteNumber).toLowerCase())) return null;
      if (String(siteNumber).includes('.')) return null;
      return { ats: 'oracleRecruiting', host: u.hostname.toLowerCase(), siteNumber };
    },
  },
  {
    id: 'icims',
    label: 'iCIMS',
    hostPattern: /(^|\.)icims\.com$/,
    // These identify an employer fronting iCIMS behind its own domain, which is
    // the common case and invisible to hostname matching.
    bodyMarkers: ['icims_content_iframe', 'iCIMS Careers Portal', 'icims_handlePostMessage'],
    enumerable: true,
    extract: (u) => {
      const segs = segmentsOf(u);
      const i = segs.indexOf('jobs');
      // A posting is /jobs/{id}/{slug}/job — the portal HOST is the coordinate,
      // since one portal is one employer.
      if (i === -1 || !/^\d+$/.test(segs[i + 1] ?? '')) {
        return { ats: 'icims', host: u.hostname.toLowerCase() };
      }
      return { ats: 'icims', host: u.hostname.toLowerCase() };
    },
  },
  {
    id: 'workable',
    label: 'Workable',
    hostPattern: /(^|\.)workable\.com$/,
    bodyMarkers: ['apply.workable.com'],
    // Covered by the cross-company atsSearch provider rather than per board.
    enumerable: true,
    extract: (u) => (u.hostname.toLowerCase().startsWith('apply.')
      ? slugCoordinate('workable', segmentsOf(u)[0])
      : null),
  },
  {
    id: 'rippling',
    label: 'Rippling',
    hostPattern: /(^|\.)rippling\.com$/,
    bodyMarkers: ['ats.rippling.com'],
    enumerable: true,
    extract: (u) => slugCoordinate('rippling', segmentsOf(u)[0]),
  },
  {
    id: 'successfactors',
    label: 'SAP SuccessFactors (RMK)',
    // RMK career sites almost always run on the EMPLOYER's own domain, so the
    // body marker — not the hostname — is the real signal here.
    hostPattern: /(^|\.)successfactors\.(com|eu)$/,
    bodyMarkers: ['rmkcdn.successfactors.com', '/view/xsl/sitemapssl.xsl'],
    // No per-tenant API: enumerate via the site's own sitemap.xml through the
    // `careers` adapter. Recorded as a platform so detection reports it.
    enumerable: false,
    note: 'Enumerate via the employer\'s own /sitemap.xml using the `careers` adapter — '
      + 'verified working (Capgemini 7,181 job URLs, EY 7,199, Wipro 4,000). There is no '
      + 'per-tenant JSON API and no RSS feed: five documented RSS patterns were tested '
      + 'and all returned the homepage or 404. Job pages carry no JSON-LD, so titles come '
      + 'from readable-content extraction.',
  },
  {
    id: 'eightfold',
    label: 'Eightfold AI',
    hostPattern: /(^|\.)eightfold\.ai$/,
    bodyMarkers: ['eightfold.ai', 'static.vscdn.net'],
    // No per-tenant API we may use, so no coordinate: enumerate through the
    // tenant's own job sitemap with the `careers` adapter instead.
    enumerable: false,
    sitemapPath: '/careers/sitemap.xml',
    note: 'Enumerate via the tenant\'s own /careers/sitemap.xml with the `careers` adapter '
      + '({ name, sitemap }). Verified 2026-11-20: Microsoft (2,446 job URLs), Qualcomm (2,069), '
      + 'Morgan Stanley (1,138), Netflix (443), John Deere (322), Starbucks (21,994); robots.txt '
      + 'allows /careers and each job page carries JobPosting JSON-LD with datePosted. The JSON '
      + 'API (/api/apply, /api/pcsx) answers 403 {"message":"Not authorized for PCSX"} or 429 '
      + 'without authorization; getting past that would be bypassing authorization, so it stays '
      + 'out of scope by policy.',
  },
  {
    id: 'phenom',
    label: 'Phenom People / Radancy TalentBrew',
    hostPattern: null,
    bodyMarkers: ['phenompeople', 'ph-hero', 'talentbrew'],
    enumerable: false,
    sitemapPath: '/sitemap.xml',
    note: 'Listing pages render client-side, but TalentBrew sites publish /sitemap.xml with '
      + '/job/{city}/{title}/{ids} URLs whose pages carry JobPosting JSON-LD with datePosted. '
      + 'Enumerate with the `careers` adapter ({ name, sitemap }). Verified 2026-11-20 on '
      + 'UnitedHealth Group (6,546 job URLs), Comcast (737) and Kaiser Permanente (2,936); '
      + 'robots.txt disallows only /search-jobs/. (The earlier note said there was no job '
      + 'sitemap; that was wrong for these sites.)',
  },
]);

/** Platform ids this codebase can actually enumerate jobs from. */
export const ENUMERABLE_PLATFORMS = Object.freeze(
  new Set(PLATFORMS.filter((p) => p.enumerable).map((p) => p.id)),
);

/**
 * Identify the platform a URL belongs to, using the hostname alone.
 *
 * @param {string} url
 * @returns {object|null} the registry entry, or null
 */
export function platformForUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? '').trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase();
  for (const platform of PLATFORMS) {
    if (!platform.hostPattern?.test(host)) {
      if (platform.vanityPath?.test(parsed.pathname)) return platform;
      continue;
    }
    // A host that serves more than its ATS must also match the path hint.
    if (platform.pathHint && !platform.pathHint.test(parsed.pathname)) continue;
    return platform;
  }
  return null;
}

/**
 * The job sitemap to try for a careers site on a platform that publishes one
 * (Eightfold, TalentBrew), or null.
 *
 * @param {string} url any page on the careers site
 * @param {object|null} [platform] the detected platform; detected from the URL when omitted
 * @returns {string|null}
 */
export function sitemapFor(url, platform = null) {
  const p = platform ?? platformForUrl(url);
  if (!p?.sitemapPath) return null;
  try {
    return new URL(p.sitemapPath, new URL(url).origin).href;
  } catch {
    return null;
  }
}

/**
 * Identify the platform behind a careers page from its HTML.
 *
 * This is the case hostname matching cannot solve: an employer serving iCIMS or
 * SuccessFactors from `careers.acme.com`. Markers are matched case-insensitively
 * against the raw HTML.
 *
 * @param {string} html
 * @returns {object|null}
 */
export function platformForHtml(html) {
  const body = String(html ?? '').toLowerCase();
  if (!body) return null;
  for (const platform of PLATFORMS) {
    for (const marker of platform.bodyMarkers ?? []) {
      if (body.includes(marker.toLowerCase())) return platform;
    }
  }
  return null;
}

/**
 * Best-effort platform detection from a URL and (optionally) the page HTML.
 *
 * The hostname is checked first because it is free and unambiguous; the body
 * markers are the fallback that catches vanity careers domains.
 *
 * @param {{url?: string, html?: string}} input
 * @returns {{platform: object, via: 'host'|'body', coordinate: object|null}|null}
 */
export function detectPlatform({ url, html } = {}) {
  const byHost = url ? platformForUrl(url) : null;
  if (byHost) {
    return { platform: byHost, via: 'host', coordinate: extractCoordinate(url) };
  }
  const byBody = html ? platformForHtml(html) : null;
  if (byBody) return { platform: byBody, via: 'body', coordinate: null };
  return null;
}

/**
 * Extract the config coordinate a job URL reveals, via the registry.
 *
 * @param {string} url a job posting or board URL
 * @returns {object|null} `{ ats, ...coordinates }`, or null when the URL names
 *   no board this codebase can enumerate
 */
export function extractCoordinate(url) {
  const platform = platformForUrl(url);
  if (!platform?.enumerable || typeof platform.extract !== 'function') return null;
  try {
    return platform.extract(new URL(url));
  } catch {
    return null;
  }
}
