import { makePlatform } from './_base.js';

export const descriptor = makePlatform({
  key: 'smartrecruiters',
  name: 'SmartRecruiters',
  selectors: {
    firstName: 'input[name="firstName"]',
    lastName: 'input[name="lastName"]',
    email: 'input[name="email"]',
    phone: 'input[name="phoneNumber"]',
    linkedin: 'input[name="linkedinProfileUrl"]',
  },
  fileInputs: {
    resume: 'input[type="file"][name="resume"]',
  },
  submitSelector: 'button[data-test="form-submit"]',
});
