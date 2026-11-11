import { makePlatform } from './_base.js';

export const descriptor = makePlatform({
  key: 'jobvite',
  name: 'Jobvite',
  selectors: {
    firstName: 'input[name="firstName"]',
    lastName: 'input[name="lastName"]',
    email: 'input[name="email"]',
    phone: 'input[name="phone"]',
  },
  fileInputs: {
    resume: 'input[type="file"][name="resume"]',
  },
  submitSelector: 'button[type="submit"]',
});
