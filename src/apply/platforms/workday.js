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
  submitSelector: 'button[data-automation-id="bottom-navigation-next-button"]',
});
