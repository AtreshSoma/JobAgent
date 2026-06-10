import { makePlatform } from './_base.js';

export const descriptor = makePlatform({
  key: 'greenhouse',
  name: 'Greenhouse',
  selectors: {
    firstName: '#first_name',
    lastName: '#last_name',
    email: '#email',
    phone: '#phone',
    linkedin: 'input[name="job_application[answers_attributes][0][text_value]"]',
  },
  fileInputs: {
    resume: '#resume_fieldset input[type="file"]',
    coverLetter: '#cover_letter_fieldset input[type="file"]',
  },
  submitSelector: '#submit_app',
});
