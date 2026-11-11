import { makePlatform } from './_base.js';

/**
 * Generic fallback adapter for unknown ATS platforms. Uses best-effort common
 * selectors; unresolved fields surface in the plan as `resolved: false` so a
 * human can complete them. Still never auto-submits.
 */
export const descriptor = makePlatform({
  key: 'generic',
  name: 'Generic',
  selectors: {
    firstName: 'input[name*="first" i]',
    lastName: 'input[name*="last" i]',
    fullName: 'input[name*="name" i]',
    email: 'input[type="email"], input[name*="email" i]',
    phone: 'input[type="tel"], input[name*="phone" i]',
    linkedin: 'input[name*="linkedin" i]',
  },
  fileInputs: {
    resume: 'input[type="file"]',
  },
  submitSelector: null,
});
