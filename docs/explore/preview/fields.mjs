/**
 * Design preview: the example data for two of the six fields.
 *
 * This is the shape the real page's content will take (one object per field,
 * every chapter reading from it). Scores are NOT written here: build.mjs runs
 * each field's `inputs` through the page's own score model
 * (src/dashboard/public/assets/explore/js/score-model.js), so the numbers in
 * the preview are the ones the real scorer's arithmetic gives.
 *
 * Every person, employer, posting and resume line is fictional.
 * {Braces} mark a skill from the example profile that the posting names.
 */

/** The morning of postings behind the headline: many professions, none dominant. */
export const HERO_FIELD = [
  { family: 'Marketing', title: 'Marketing Manager', company: 'Fabrikam' },
  { family: 'Healthcare', title: 'Registered Nurse, ICU', company: 'Lamna Healthcare' },
  { family: 'Finance', title: 'Financial Analyst', company: 'Woodgrove Bank' },
  { family: 'Design', title: 'UX Designer', company: 'Adventure Works' },
  { family: 'Education', title: 'Math Teacher', company: 'Bellows College' },
  { family: 'Security', title: 'Cloud Security Engineer', company: 'Tailspin Toys' },
  { family: 'Skilled trades', title: 'Electrician', company: 'City Power & Light' },
  { family: 'Operations', title: 'Warehouse Supervisor', company: 'Wide World Importers' },
  { family: 'People', title: 'HR Generalist', company: 'Proseware' },
  { family: 'Data', title: 'Data Analyst', company: 'Litware' },
];

/** The six options of "See it for your field". Two are built in this preview. */
export const FIELD_OPTIONS = [
  { id: 'software', label: 'Software Engineer', short: 'Software', built: true },
  { id: 'security', label: 'Cybersecurity Analyst', short: 'Security', built: false },
  { id: 'regulatory', label: 'Regulatory Affairs', short: 'Regulatory', built: true },
  { id: 'nursing', label: 'Registered Nurse', short: 'Nursing', built: false },
  { id: 'marketing', label: 'Marketing Manager', short: 'Marketing', built: false },
  { id: 'finance', label: 'Financial Analyst', short: 'Finance', built: false },
];

export const FIELDS = {
  software: {
    label: 'Software Engineer',
    family: 'Software Engineering',
    person: 'Jordan',
    job: { title: 'Senior Full-Stack Engineer', company: 'Northwind Traders', location: 'Remote, US', via: 'Greenhouse', posted: '2 days ago' },
    // 5 of 8 profile skills found, one of them only under "nice to have". No sponsorship needed.
    inputs: { needsSponsorship: false, skillsFound: 5, skillsPreferredOnly: 1, location: 'remote', ageDays: 2 },
    posting: {
      requires: 'Build product features in {React} and {TypeScript}, with {Node.js} services on {PostgreSQL}. You are comfortable with feature flags and trunk-based development.',
      prefers: '{AWS}, Kubernetes.',
      condition: { tag: 'On-call', sentence: 'Engineers join the on-call rotation one week in six.' },
    },
    evidence: [
      { skill: 'React, TypeScript', line: 'Rebuilt the checkout flow in React and TypeScript, cutting load time from 4.1 s to 1.8 s.' },
      { skill: 'Node.js, PostgreSQL', line: 'Designed the orders service in Node.js on PostgreSQL.' },
      { skill: 'AWS', line: 'Moved the nightly jobs to AWS Lambda.' },
    ],
    gap: 'Kubernetes',
    alsoAsked: ['feature flags', 'trunk-based development'],
    resume: {
      role: 'Software Engineer, Contoso',
      summary: 'Full-stack engineer with six years of customer-facing web products in {React}, {TypeScript} and {Node.js}.',
      bullets: [
        { id: 'b1', rank: 4, text: 'Mentored four engineers and ran the on-call rotation.' },
        { id: 'b2', rank: 1, text: 'Rebuilt the checkout flow in {React} and {TypeScript}, cutting load time from 4.1 s to 1.8 s.' },
        { id: 'b3', rank: 0, text: 'Organized the team’s quarterly hack week.' },
        { id: 'b4', rank: 2, text: 'Designed the orders service in {Node.js} on {PostgreSQL}.' },
        { id: 'b5', rank: 3, text: 'Moved the nightly jobs to {AWS} Lambda.' },
      ],
      skills: { master: ['JavaScript', 'React', 'TypeScript', 'Node.js', 'PostgreSQL', 'GraphQL', 'AWS', 'Docker'], tailored: ['React', 'TypeScript', 'Node.js', 'PostgreSQL', 'AWS', 'JavaScript', 'GraphQL', 'Docker'] },
      wanted: ['React', 'TypeScript', 'Node.js', 'PostgreSQL', 'AWS'],
    },
  },

  regulatory: {
    label: 'Regulatory Affairs',
    family: 'Regulatory Affairs & Quality',
    person: 'Priya',
    job: { title: 'Senior Regulatory Affairs Specialist, CMC', company: 'Trey Research', location: 'Hybrid, Raleigh NC', via: 'Workday', posted: '3 days ago' },
    // 5 of 8 found, one preferred only; the industry matches; one year short of the stated floor.
    inputs: { needsSponsorship: false, skillsFound: 5, skillsPreferredOnly: 1, domainMatch: true, eligibility: 'stretch1', location: 'onsite_ok', ageDays: 3 },
    posting: {
      requires: '[6+ years] in regulatory affairs. Author {CMC} sections of {IND} submissions in {eCTD} format, including {Module 3}, and manage post-approval change assessments.',
      prefers: '{Veeva Vault}, biologics.',
      condition: { tag: 'Travel 10%', sentence: 'Up to 10% travel to manufacturing sites.' },
    },
    evidence: [
      { skill: 'CMC, Module 3, IND', line: 'Authored Module 3 CMC sections for two IND submissions.' },
      { skill: 'eCTD', line: 'Compiled and published eCTD sequences for an NDA supplement.' },
      { skill: 'Veeva Vault', line: 'Tracked submission documents in Veeva Vault.' },
    ],
    gap: 'Biologics',
    alsoAsked: ['post-approval change assessments'],
    resume: {
      role: 'Regulatory Affairs Specialist, Fabrikam Life Sciences',
      summary: 'Regulatory affairs specialist with five years of {CMC} authoring for {IND} and NDA submissions in {eCTD} format.',
      bullets: [
        { id: 'b1', rank: 4, text: 'Trained three new associates on document control.' },
        { id: 'b2', rank: 1, text: 'Authored {Module 3} {CMC} sections for two {IND} submissions.' },
        { id: 'b3', rank: 0, text: 'Coordinated the department’s annual audit calendar.' },
        { id: 'b4', rank: 2, text: 'Compiled and published {eCTD} sequences for an NDA supplement.' },
        { id: 'b5', rank: 3, text: 'Tracked submission documents in {Veeva Vault}.' },
      ],
      skills: { master: ['FDA correspondence', 'ICH guidelines', 'CMC', 'eCTD', 'Module 3', 'IND', 'NDA', 'Veeva Vault'], tailored: ['CMC', 'Module 3', 'IND', 'eCTD', 'Veeva Vault', 'NDA', 'ICH guidelines', 'FDA correspondence'] },
      wanted: ['CMC', 'IND', 'eCTD', 'Module 3', 'Veeva Vault'],
    },
  },
};

/** How strong a match, in plain words, for each tier the scorer can give. */
export const TIER_GLOSS = {
  Priority: 'A very strong match. Apply first.',
  Apply: 'A strong match. Worth applying.',
  Queue: 'A possible match. Yours to judge.',
  'Near miss': 'Close, and missing something that matters.',
  Discard: 'Not a match for this search.',
};

/**
 * The capability register as the finished page will carry it. Status follows
 * the code on this branch (see docs/explore/critique.md, Truth), not the brief:
 * several items the brief lists as planned have shipped since it was written.
 * `fresh` marks what arrived in v0.2.3 or later.
 */
export const REGISTER = {
  Find: [
    ['Employer application systems', 'Nine public job feeds read directly, politely, with retries.', 'shipped'],
    ['Cross-company title search', 'Searches by your target titles across employers. No key needed.', 'shipped'],
    ['Add a job by link', 'Paste any public posting. It is read, scored and tracked like the rest.', 'shipped'],
    ['Search by job role', 'A one-off search for a role outside your profile, kept apart from your main list.', 'shipped'],
    ['Watch mode', 'Checks for new strong matches on a timer and can notify you.', 'shipped'],
    ['Closed-posting sweep', 'Asks whether a saved posting still exists and retires the ones that do not.', 'shipped'],
    ['Skip unchanged boards', 'A Workday board that has not changed is skipped, with a full sweep every 3 days. Workday only.', 'shipped', true],
    ['Daily scheduled search', 'A daily search through your computer’s own scheduler. Searches and scores only.', 'optional', true],
    ['Background description fetching', 'Reads full descriptions for postings listed by title only.', 'optional'],
    ['Adzuna and Apify sources', 'Wider coverage through official APIs, with your own key.', 'optional'],
    ['Results while a search is running', 'Jobs appearing before the run has finished.', 'planned'],
    ['Hacker News “Who is hiring”', 'One more source on a public API.', 'planned'],
  ],
  Match: [
    ['Fit score with reasons', 'A score out of 100, the same every time, with every point explained.', 'shipped'],
    ['Requirement checks', 'Reads stated years, degree, licence and clearance, and holds a job you do not meet.', 'shipped'],
    ['Hidden conditions', 'Eleven kinds, from on-call to travel, lifted out as tags that open to their sentence.', 'shipped'],
    ['Evidence for each skill', 'The line of your resume that shows each skill asked for. One rule for the score, the packet and the gap list.', 'shipped', true],
    ['Also asked for', 'Requirements outside what JobAgent looks for, word for word. You choose what to add.', 'shipped', true],
    ['Sponsorship reading', 'Confirmed, Likely, Unconfirmed or Denied, with the sentence that decided it.', 'shipped'],
    ['Employer history', 'What this employer has posted before, from postings you saved.', 'shipped'],
    ['Profiles for 26 role families', 'Built from your resume. Several people can share one install.', 'shipped'],
    ['Setup card', 'One line on what is left before applying. Searching and scoring work meanwhile.', 'shipped', true],
    ['Rank by meaning', 'A second, labelled number from text embeddings. It never changes the score.', 'optional'],
    ['Weight tuning from outcomes', 'Proposes small weight changes once you have enough results. You apply them.', 'optional'],
  ],
  Prepare: [
    ['Resume tailoring', 'Reorders and emphasizes what is already yours in a per-job copy.', 'shipped'],
    ['Resume check on upload', 'Says what JobAgent understood from your resume, and what it could not read.', 'shipped', true],
    ['Measured page fit', 'The page count comes from rendering the document, not from a guess.', 'shipped', true],
    ['PDF from your own Word file', 'Keeps your fonts and layout.', 'shipped', true],
    ['Compare with master', 'Every line that moved, was reworded or was left out.', 'shipped'],
    ['Undo one failed step', 'A tailoring step that fails is undone on its own. The rest is kept.', 'shipped', true],
    ['Readiness report', 'Keyword coverage, layout problems an application system trips on, honest gaps.', 'shipped'],
    ['Master cover letter, with versions', 'One letter you own, adapted per job, with every version kept.', 'shipped'],
    ['Document versions', 'Every prepared resume and letter is kept. The submitted set is frozen.', 'shipped'],
    ['Requirement reading with a model', 'A model reads the posting only. Every phrase must appear in it word for word.', 'optional'],
    ['Verified bullet rewrites', 'A model proposes rewordings. A checker, then you, decide.', 'optional'],
    ['Grounded cover letters', 'A model writes paragraphs that must cite your resume. Unverified ones are dropped.', 'optional'],
  ],
  Apply: [
    ['Approval queue', 'Nothing is filled until you approve, and the approval covers exactly what you saw.', 'shipped'],
    ['Auto-fill readiness', 'Before filling: does this employer need an account, and which questions are unanswered?', 'shipped'],
    ['Assisted form filling', 'Fills the live form in a browser you can watch, and stops before Submit.', 'shipped'],
    ['Work history and education', 'Fills repeated history sections. Tested on a test page only, not yet on a live employer site.', 'shipped', true],
    ['Answer once, reuse everywhere', 'Your answers are kept per person and fill every later form.', 'shipped'],
    ['Sign in once, retry all', 'Jobs stopped at an employer sign-in are grouped, with one button to retry them.', 'shipped'],
    ['Dry run', 'Shows what would be filled. Changes nothing on the application page.', 'shipped', true],
    ['Drafted answers to open questions', 'A model drafts from your resume. You approve each one, per job.', 'optional', true],
    ['Wait at a sign-in', 'Waits while you clear a sign-in or CAPTCHA yourself, then carries on.', 'optional', true],
    ['Several applications at once', 'Up to three, never two at one employer. Command line only.', 'optional', true],
    ['Browser extension', 'Fills an approved application in the tab you already have open.', 'optional'],
    ['Coverage probe', 'Reads a saved application page and reports what auto-fill could answer.', 'experimental'],
    ['Final auto-submit', 'Refused on every application system until a supervised live run is recorded. None is.', 'experimental'],
  ],
  Track: [
    ['Applications board', 'Stages, outcomes, notes and follow-up reminders.', 'shipped'],
    ['Today', 'What needs you now: approvals, follow-ups due, sign-ins.', 'shipped'],
    ['What gets interviews', 'Outcomes by role family and by resume, once you have recorded some.', 'shipped', true],
    ['Interview prep pack', 'One printable page, quoted from the posting and your resume.', 'shipped', true],
    ['Exports', 'A spreadsheet of every job, a tracker, and follow-ups as a calendar file.', 'shipped'],
    ['Email replies', 'Reads your inbox, never changes it, and suggests outcomes.', 'optional'],
    ['Follow-up alerts', 'A desktop notification when a reminder comes due.', 'optional'],
    ['Google Calendar sync', 'Follow-ups written straight to a calendar.', 'planned'],
  ],
  Platform: [
    ['Backups, export and import', 'Daily snapshots and a one-file bundle of everything personal, optionally encrypted.', 'shipped'],
    ['One setup step', 'The launcher sets up everything it needs, Python included.', 'shipped', true],
    ['Identity kept from AI', 'Lines with your name, email, phone or profile link are removed before any model call.', 'shipped', true],
    ['Sign out everywhere', 'Removes the saved employer sign-ins for one person.', 'shipped', true],
    ['Command palette and keyboard triage', 'Every action from the keyboard.', 'shipped'],
    ['Doctor', 'A checklist for the database, your resume, Python and the browser.', 'shipped'],
    ['Assistant access (MCP)', 'Lets an assistant on this computer read your jobs, add a note or record an outcome. It cannot approve, fill or submit.', 'optional'],
    ['Packaged installer', 'A download you double-click.', 'planned'],
  ],
};

export const STATUS = {
  shipped: { label: 'Implemented', note: 'Works out of the box.' },
  optional: { label: 'Optional', note: 'Built. Off until you turn it on.' },
  experimental: { label: 'Experimental', note: 'Built and tested. Not offered in the dashboard.' },
  planned: { label: 'Planned', note: 'Not built yet.' },
};
