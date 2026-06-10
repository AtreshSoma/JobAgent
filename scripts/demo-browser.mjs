/**
 * Visible (headed) browser demo.
 *
 * Drives the REAL automation engine (the same modules `npm run assist` uses)
 * against a LOCAL fixture form so you can watch Chromium open, fill fields, and
 * upload the resume. It NEVER submits — it stops and leaves the window open.
 *
 *   node scripts/demo-browser.mjs
 */

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createBrowserSession, openApplicationPage } from '../src/automation/browser.js';
import { fillFields } from '../src/automation/fieldResolver.js';
import { uploadFiles } from '../src/automation/uploadRunner.js';

const fixtures = join(process.cwd(), 'tests', 'node', 'fixtures');
const formUrl = pathToFileURL(join(fixtures, 'apply_form.html')).href;
const resume = join(fixtures, 'sample_resume.txt');
const cover = join(fixtures, 'sample_cover.txt');

const fillPlan = {
  steps: [
    { field: 'first_name', label: 'First name', value: 'Atresh', source: 'profile', selector: '#first_name' },
    { field: 'last_name', label: 'Last name', value: 'Somayajula', source: 'profile', selector: '#last_name' },
    { field: 'email', label: 'Email', value: 'atresh@example.com', source: 'profile', selector: '#email' },
    { field: 'phone', label: 'Phone', value: '555-0100', source: 'profile', selector: '#phone' },
  ],
  uploads: [
    { type: 'resume', path: resume, selector: '#resume' },
    { type: 'coverLetter', path: cover, selector: '#cover_letter' },
  ],
  submitSelector: '#submit_app',
};

console.log('Launching a VISIBLE Chromium window (slow motion)...');
const session = await createBrowserSession({ headless: false, slowMo: 600 });

const nav = await openApplicationPage(session.page, formUrl);
console.log(`Opened form. Page guard blocked: ${nav.guard.blocked}`);

const fill = await fillFields(session.page, fillPlan);
console.log(`Filled fields: ${fill.filled.map((f) => f.field).join(', ')}`);

const up = await uploadFiles(session.page, fillPlan);
console.log(`Uploaded: ${up.uploaded.map((u) => u.type).join(', ')}`);

console.log('STOPPING before submit (no click). Window stays open ~25s so you can see it.');
await new Promise((r) => setTimeout(r, 25000));

await session.close();
console.log('Demo complete. Browser closed. Nothing was submitted.');
