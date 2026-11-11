import { makePlatform } from './_base.js';

export const descriptor = makePlatform({
  key: 'lever',
  name: 'Lever',
  selectors: {
    fullName: 'input[name="name"]',
    email: 'input[name="email"]',
    phone: 'input[name="phone"]',
    linkedin: 'input[name="urls[LinkedIn]"]',
    github: 'input[name="urls[GitHub]"]',
    portfolio: 'input[name="urls[Portfolio]"]',
  },
  fileInputs: {
    resume: 'input[name="resume"]',
  },
  submitSelector: 'button[type="submit"].template-btn-submit',
});
