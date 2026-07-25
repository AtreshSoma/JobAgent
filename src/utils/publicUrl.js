/**
 * Shared "is this a safe PUBLIC http(s) URL to fetch?" guard.
 *
 * The agent fetches URLs the user pastes and URLs an extension observes. Both
 * must be real, public job postings. A local or private-network address is never
 * a job posting, and fetching one turns a local convenience feature into a
 * request forgery primitive against the user's own machine and LAN (cloud
 * metadata endpoints, router admin pages, internal dashboards).
 *
 * Pure, dependency-free, and deliberately conservative: it blocks by literal
 * address shape. It cannot stop a public hostname that RESOLVES to a private
 * address (that needs resolution-time checking), so it is a first line of
 * defense, not a complete SSRF fix — see assertPublicHttpUrl's notes.
 */

/** Hostnames that mean "this machine". */
const LOOPBACK_HOSTNAMES = new Set([
  '127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', '[::]',
]);

/** Longest URL we will accept (DB column + UI sanity). */
export const MAX_URL_LENGTH = 2048;

/**
 * Literal IPv4/IPv6 address ranges that are never a public job posting.
 *   10/8, 172.16/12, 192.168/16   private (RFC 1918)
 *   127/8                        loopback
 *   169.254/16                   link-local — includes cloud metadata
 *                                (169.254.169.254 on AWS/Azure/GCP)
 *   100.64/10                    carrier-grade NAT / tailscale
 *   0/8, 224/4, 240/4            unspecified / multicast / reserved
 *   fc00::/7, fe80::/10          IPv6 unique-local and link-local
 */
const PRIVATE_IPV4_RE = new RegExp([
  '^10\\.',
  '^127\\.',
  '^169\\.254\\.',
  '^172\\.(?:1[6-9]|2\\d|3[01])\\.',
  '^192\\.168\\.',
  '^100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.',
  '^0\\.',
  '^(?:22[4-9]|23\\d|24\\d|25[0-5])\\.',
].join('|'));

const PRIVATE_IPV6_RE = /^(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;

/** Hostname suffixes that only ever resolve inside a private network. */
const INTERNAL_SUFFIXES = ['.local', '.internal', '.localdomain', '.home.arpa', '.lan'];

/**
 * Validate a URL as a fetchable public http(s) address.
 *
 * @param {unknown} value candidate URL
 * @returns {{ ok: boolean, reason: string|null, url: URL|null }}
 */
export function assertPublicHttpUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return fail('a URL is required');
  if (raw.length > MAX_URL_LENGTH) return fail(`URL is longer than ${MAX_URL_LENGTH} characters`);

  let url;
  try { url = new URL(raw); }
  catch { return fail('not a valid URL'); }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return fail('only http(s) URLs can be read (no file:, data:, or custom schemes)');
  }
  // Credentials in a job URL are always a mistake and would be sent upstream.
  if (url.username || url.password) return fail('remove the credentials from the URL');

  const host = url.hostname.toLowerCase();
  const bare = host.replace(/^\[|\]$/g, '');

  if (LOOPBACK_HOSTNAMES.has(host) || LOOPBACK_HOSTNAMES.has(bare)) {
    return fail('that is a local address, not a public job posting');
  }
  if (PRIVATE_IPV4_RE.test(bare) || PRIVATE_IPV6_RE.test(bare)) {
    return fail('that is a private or link-local network address, not a public job posting');
  }
  if (INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return fail('that hostname is internal to your network, not a public job posting');
  }
  // A bare single-label host ("intranet", "jobs") can only be internal.
  if (!host.includes('.')) {
    return fail('that hostname is not a public domain');
  }

  return { ok: true, reason: null, url };
}

/** Convenience boolean form. */
export function isPublicHttpUrl(value) {
  return assertPublicHttpUrl(value).ok;
}

function fail(reason) {
  return { ok: false, reason, url: null };
}
