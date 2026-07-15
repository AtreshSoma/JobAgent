import { makePlatform } from './_base.js';

export const descriptor = makePlatform({
  key: 'workday',
  name: 'Workday',
  selectors: {
    firstName: 'input[data-automation-id="legalNameSection_firstName"]',
    lastName: 'input[data-automation-id="legalNameSection_lastName"]',
    email: 'input[data-automation-id="email"]',
    phone: 'input[data-automation-id="phone-number"]',
  },
  fileInputs: {
    resume: 'input[data-automation-id="file-upload-input-ref"]',
  },
  // Workday reuses its bottom-navigation control across intermediate and final
  // steps. Treating that selector as a guaranteed final Submit is unsafe; the
  // live runner identifies a final control from its explicit text instead.
  submitSelector: null,
});
