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
  // Hints only — uploadRunner matches file inputs by their labels first. The
  // first selector is the classic boards.greenhouse.io fieldset; the second is
  // the current job-boards.greenhouse.io React form (`<input id="resume">`
  // hidden behind an "Attach" button, labelled by a sibling div).
  fileInputs: {
    resume: '#resume_fieldset input[type="file"], input[type="file"]#resume',
    coverLetter: '#cover_letter_fieldset input[type="file"], input[type="file"]#cover_letter',
  },
  submitSelector: '#submit_app',
});
