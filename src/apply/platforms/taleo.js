import { makePlatform } from './_base.js';

export const descriptor = makePlatform({
  key: 'taleo',
  name: 'Taleo',
  selectors: {
    firstName: 'input[id*="firstName"]',
    lastName: 'input[id*="lastName"]',
    email: 'input[id*="email"]',
    phone: 'input[id*="phone"]',
  },
  fileInputs: {
    resume: 'input[type="file"]',
  },
  submitSelector: 'a[id*="submitButton"]',
});
