/**
 * Page safety guards.
 *
 * Pure, deterministic detectors for situations the agent must NEVER try to get
 * past: CAPTCHAs, login/auth walls, multi-factor prompts, and bot-protection
 * interstitials (Cloudflare/PerimeterX/etc.). These functions inspect page text
 * + URL only and return a structured verdict. The automation layer uses them to
 * STOP and hand control back to the human — it never solves, bypasses, or
 * automates around any of these.
 */

/**
 * STRONG signals: unambiguous "you are blocked" phrases. The mere presence of
 * any of these means the page IS a challenge/login/interstitial — we block
 * regardless of how much other content is on the page.
 */
const BLOCKING_PHRASES = Object.freeze({
  captcha: [
    'are you a robot', 'i am not a robot', 'verify you are human',
    'verify you are a human', 'please verify you are human',
    'complete the security check', 'complete a security check',
    'press and hold to confirm', 'solve the puzzle to continue',
  ],
  login: [
    'sign in to continue', 'please log in', 'please sign in', 'log in to apply',
    'sign in to apply', 'create an account to apply', 'login required',
    'you must be logged in', 'session expired',
    // Aggregator account gates (e.g. Indeed's interstitial before redirecting
    // to the company site). We never auto-create accounts or replay logins.
    'create an account or sign in', 'before applying on company site',
    'you must create an indeed account',
  ],
  mfa: [
    'two-factor', 'two factor', 'multi-factor', 'multifactor',
    'one-time passcode', 'one time passcode', 'authenticator app',
    'enter the code we sent', 'enter the verification code',
    'security code we sent',
  ],
  bot: [
    'checking your browser', 'ddos protection', 'perimeterx',
    'access denied', 'request blocked', 'unusual traffic', 'bot detection',
    'datadome', 'incapsula', 'akamai bot manager',
    // Cloudflare's "Additional Verification Required" interstitial (shows a
    // Ray ID). Indeed fronts its pages with this and blocks automated browsers.
    'additional verification required', 'ray id', 'cf-ray',
    'troubleshooting cloudflare errors', 'attention required',
  ],
});

/**
 * WEAK signals: tokens that ALSO appear on perfectly usable pages, because many
 * career/ATS sites embed a captcha or 2FA widget in a newsletter/search/alert
 * form (e.g. "Get notified for similar jobs"). These count as a block ONLY when
 * the page is a thin, dedicated challenge/interstitial — never when the widget
 * is merely embedded in a full job/application page. This prevents the agent
 * from falsely stopping on a clean posting that happens to load reCAPTCHA.
 */
const WIDGET_TOKENS = Object.freeze({
  captcha: [
    'recaptcha', 'g-recaptcha', 'grecaptcha', 'hcaptcha', 'h-captcha',
    'cf-turnstile', 'turnstile', 'captcha',
  ],
  mfa: ['2fa', 'verification code', 'security code'],
});

/** A dedicated challenge/interstitial page is short; real content pages are not. */
const THIN_PAGE_MAX = 2000;

/** URL-host fragments that indicate an auth/login redirect. */
const LOGIN_URL_HINTS = ['/login', '/signin', '/sign-in', '/auth', '/account/login', 'accounts.google.com'];

/**
 * Inspect page content + URL for blocking conditions.
 *
 * @param {object} input
 * @param {string} [input.html] page HTML or visible text
 * @param {string} [input.url] current URL
 * @param {number} [input.status] HTTP status code, if known
 * @returns {{
 *   blocked: boolean,
 *   kind: 'captcha'|'login'|'mfa'|'bot'|null,
 *   reason: string|null,
 *   signals: string[]
 * }}
 */
export function detectBlocker({ html = '', url = '', status } = {}) {
  const haystack = `${html} ${url}`.toLowerCase();
  const signals = [];

  // HTTP-level blocks first (cheap + unambiguous).
  if (status === 401 || status === 403) {
    return block(status === 401 ? 'login' : 'bot', `HTTP ${status}`, [`http:${status}`]);
  }
  if (status === 429) {
    return block('bot', 'HTTP 429 (rate limited)', ['http:429']);
  }

  // URL-based login redirect. Each hint must end at a path/query boundary so
  // "/auth" never matches "/author…" and "/signin" never matches a longer slug.
  const urlLower = url.toLowerCase();
  for (const hint of LOGIN_URL_HINTS) {
    if (hintMatchesUrl(urlLower, hint)) {
      signals.push(`url:${hint}`);
    }
  }

  // 1) Strong, unambiguous challenge phrases — block regardless of page size.
  for (const kind of ['captcha', 'mfa', 'bot', 'login']) {
    const hit = BLOCKING_PHRASES[kind].find((token) => haystack.includes(token));
    if (hit) return block(kind, `${kind} signal: "${hit}"`, [...signals, `text:${hit}`]);
  }

  // 2) Weak widget tokens only count on a THIN, dedicated challenge page — not
  //    when a captcha/2FA widget is merely embedded in a full content page.
  const thin = html.length > 0 && html.length <= THIN_PAGE_MAX;
  if (thin) {
    for (const kind of ['captcha', 'mfa']) {
      const hit = WIDGET_TOKENS[kind].find((token) => haystack.includes(token));
      if (hit) return block(kind, `${kind} challenge: "${hit}"`, [...signals, `text:${hit}`]);
    }
  }

  if (signals.length) {
    return block('login', `login redirect (${signals.join(', ')})`, signals);
  }

  return { blocked: false, kind: null, reason: null, signals: [] };
}

function block(kind, reason, signals) {
  return { blocked: true, kind, reason, signals };
}

/**
 * True when a login hint appears in the URL at a segment boundary — followed
 * by / ? # & . or the end of the string. Prevents substring false positives
 * like "/auth" matching a legitimate "/authors" or "/authorized-dealers" page.
 * @param {string} urlLower lowercased URL
 * @param {string} hint one of LOGIN_URL_HINTS
 * @returns {boolean}
 */
function hintMatchesUrl(urlLower, hint) {
  let from = 0;
  for (;;) {
    const idx = urlLower.indexOf(hint, from);
    if (idx === -1) return false;
    const next = urlLower[idx + hint.length];
    if (next === undefined || '/?#&.'.includes(next)) return true;
    from = idx + 1;
  }
}

/** True when the page is safe to interact with (no blocker detected). */
export function isSafeToProceed(input) {
  return !detectBlocker(input).blocked;
}

/** Combined view of every known signal token (handy for diagnostics/tests). */
export const GUARD_SIGNALS = Object.freeze({
  captcha: [...BLOCKING_PHRASES.captcha, ...WIDGET_TOKENS.captcha],
  login: [...BLOCKING_PHRASES.login],
  mfa: [...BLOCKING_PHRASES.mfa, ...WIDGET_TOKENS.mfa],
  bot: [...BLOCKING_PHRASES.bot],
});
