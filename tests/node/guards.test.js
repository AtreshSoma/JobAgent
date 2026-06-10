import { describe, it, expect } from 'vitest';

import { detectBlocker, isSafeToProceed } from '../../src/automation/guards.js';

describe('detectBlocker', () => {
  it('detects a reCAPTCHA challenge from page content', () => {
    const v = detectBlocker({ html: '<div class="g-recaptcha"></div> verify you are human' });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('captcha');
  });

  it('detects an hCaptcha / turnstile challenge', () => {
    expect(detectBlocker({ html: 'cf-turnstile widget' }).kind).toBe('captcha');
    expect(detectBlocker({ html: 'please solve the hcaptcha' }).kind).toBe('captcha');
  });

  it('detects a login wall from content', () => {
    const v = detectBlocker({ html: 'You must be logged in to apply' });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('login');
  });

  it('detects a login redirect from the URL', () => {
    const v = detectBlocker({ html: 'welcome', url: 'https://jobs.example.com/login?next=/apply' });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('login');
  });

  it('detects an MFA prompt', () => {
    const v = detectBlocker({ html: 'Enter the verification code we sent to your phone' });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('mfa');
  });

  it('detects bot protection (Cloudflare-style)', () => {
    const v = detectBlocker({ html: 'Checking your browser before accessing. Cloudflare' });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('bot');
  });

  it('detects the Indeed "Additional Verification Required" Cloudflare wall', () => {
    const v = detectBlocker({
      html: 'Additional Verification Required. Your Ray ID for this request is a074781a9cad3ae2. Troubleshooting Cloudflare Errors',
      url: 'https://www.indeed.com/viewjob?jk=01db32821377d68d',
      status: 200,
    });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('bot');
  });

  it('does NOT flag a real job page that merely embeds a reCAPTCHA widget', () => {
    // Career sites often embed reCAPTCHA on a "Get notified" newsletter form.
    // A large, content-rich page with a widget token must stay unblocked.
    const big = 'CenterWell Lead Data Engineer. Become a part of our caring community. '.repeat(2000)
      + '<div class="g-recaptcha" data-sitekey="x"></div><script src="recaptcha/api.js"></script>'
      + 'Get notified for similar jobs';
    const v = detectBlocker({ html: big, url: 'https://www.centerwellcareers.com/us/en/job/123', status: 200 });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe(null);
  });

  it('still flags a THIN dedicated captcha/turnstile interstitial', () => {
    expect(detectBlocker({ html: 'cf-turnstile widget', status: 200 }).kind).toBe('captcha');
    expect(detectBlocker({ html: 'please solve the hcaptcha', status: 200 }).kind).toBe('captcha');
  });

  it('maps HTTP status codes to blockers', () => {
    expect(detectBlocker({ status: 401 }).kind).toBe('login');
    expect(detectBlocker({ status: 403 }).kind).toBe('bot');
    expect(detectBlocker({ status: 429 }).kind).toBe('bot');
  });

  it('passes a clean application page', () => {
    const v = detectBlocker({ html: '<form id="application_form"><input id="email"></form>', status: 200 });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe(null);
    expect(isSafeToProceed({ html: 'apply now', status: 200 })).toBe(true);
  });
});
