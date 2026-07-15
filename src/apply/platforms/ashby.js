import { makePlatform } from './_base.js';

/**
 * Ashby uses React-rendered forms, so live dynamic scanning remains the primary
 * path. These semantic selectors cover its common identity/file controls and
 * intentionally stop before any final submit control.
 */
export const descriptor = makePlatform({
  key: 'ashby',
  name: 'Ashby',
  selectors: {
    fullName: 'input[name="name"], input[autocomplete="name"]',
    firstName: 'input[name="firstName"], input[autocomplete="given-name"]',
    lastName: 'input[name="lastName"], input[autocomplete="family-name"]',
    email: 'input[name="email"], input[type="email"]',
    phone: 'input[name="phone"], input[type="tel"]',
    linkedin: 'input[name*="linkedin" i]',
  },
  fileInputs: {
    resume: 'input[type="file"][name*="resume" i], input[type="file"]',
  },
  submitSelector: null,
});
