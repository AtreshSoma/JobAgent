import { makePlatform } from './_base.js';

export const descriptor = makePlatform({
  key: 'icims',
  name: 'iCIMS',
  selectors: {
    firstName: 'input[name="firstname"]',
    lastName: 'input[name="lastname"]',
    email: 'input[name="email"]',
    phone: 'input[name="phone"]',
  },
  fileInputs: {
    resume: 'input[type="file"][name="resume"]',
  },
  submitSelector: 'input[type="submit"]',
});
