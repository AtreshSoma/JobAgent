/**
 * Explore JobAgent: the Product Overview's content, as plain data.
 *
 * No DOM access, so it can be imported by tests. Everything here describes
 * behaviour that exists in this repository; `tests/node/exploreContent.test.js`
 * compares the parts that mirror code (sources, tiers, statuses) with the code
 * itself, so this page cannot quietly drift from what the product does.
 *
 * The example posting, company and resume lines are illustrative. They are
 * labelled as such wherever they are shown.
 */

/** How finished a capability is. The four values the page distinguishes. */
export const STATUS = Object.freeze({
  shipped: { label: 'Implemented', note: 'Works out of the box, no extra setup.' },
  optional: { label: 'Optional', note: 'Built, and off until you turn it on or add a key.' },
  experimental: { label: 'Experimental', note: 'Built and tested, deliberately not offered in the dashboard.' },
  planned: { label: 'Planned', note: 'On the roadmap. Not built.' },
});

/** The illustrative posting that travels through the journey. */
export const EXAMPLE_JOB = Object.freeze({
  company: 'Northwind Analytics',
  title: 'Senior Data Engineer',
  location: 'Remote, US',
  source: 'Greenhouse',
  posted: '2 days ago',
});

/**
 * The five stages of the journey, in the order work moves through them.
 * `topic` is the Technical Deep Dive section that explains the stage; `fact`
 * is the one true line printed under its stop on the route (the test checks
 * the number in Discover's against the adapter registry).
 */
export const JOURNEY = Object.freeze([
  {
    id: 'discover',
    fact: '18 source adapters',
    name: 'Discover',
    title: 'It reads the job boards so you do not have to',
    body: 'One run asks every source you have enabled, in parallel and politely: public applicant-tracking-system feeds, a cross-company search, company careers pages, and any link you paste. Copies of the same role are merged, old postings are set aside, and hard mismatches are removed with the reason kept.',
    you: 'Press Find jobs, or leave watch mode running.',
    agent: 'Fetches, normalizes, de-duplicates, checks freshness, applies your exclusions.',
    yours: 'Which sources are on, how fresh a posting must be, what counts as a mismatch.',
    topic: 'discovery',
  },
  {
    id: 'score',
    fact: 'Every point explained',
    name: 'Score',
    title: 'Every posting gets a score you can read',
    body: 'Scoring is deterministic: the same posting and the same profile always give the same number. Each category shows the points it earned and why, the terms that matched, and the gaps. The score sorts a posting into Priority, Apply, Queue, Near miss or Discard.',
    you: 'A ranked board, a tier, and a plain-language explanation on every row.',
    agent: 'Weighs title, skills, seniority, location, freshness, sponsorship and stated requirements.',
    yours: 'The weights and thresholds live in a config file you can edit.',
    topic: 'scoring',
  },
  {
    id: 'tailor',
    fact: 'Your words, reordered',
    name: 'Tailor',
    title: 'Your resume, reordered for this job. Not rewritten.',
    body: 'For strong matches JobAgent builds a per-job copy of your master resume. It moves your most relevant bullets and skills to the front and bolds the terms the posting asks for. It does not add, remove or reword a claim. A skill the posting wants and your resume lacks is reported as a gap.',
    you: 'A tailored resume, a cover letter, and an ATS readiness report to review.',
    agent: 'Tiers the posting’s keywords, permutes existing content, checks the result.',
    yours: 'The master resume is opened read-only and never modified.',
    topic: 'tailoring',
  },
  {
    id: 'fill',
    fact: 'Fields filled, files attached',
    name: 'Fill',
    title: 'It fills the form, then stops',
    body: 'After you approve a packet, JobAgent opens the application in a real browser window, types your details, attaches the documents and answers the questions you have already answered once. It moves through Next and Continue. It stops before the final Submit, and it stops at once for a CAPTCHA, a login, a verification code or a bot wall.',
    you: 'A filled form in an open browser, with a list of anything it left for you.',
    agent: 'Scans the live form, fills from your profile and saved answers, verifies what it typed.',
    yours: 'You read the form and you click Submit.',
    topic: 'autofill',
  },
  {
    id: 'track',
    fact: 'Outcomes and follow-ups',
    name: 'Track',
    title: 'What happened next, in one place',
    body: 'Once you confirm a submission, the application moves to its own board. Record an interview, an offer or a rejection, set a follow-up reminder, and export it all to a spreadsheet or your calendar. If you connect an inbox, replies from employers are read (never changed) and suggested as outcomes for you to confirm.',
    you: 'Applications by stage, follow-ups due, and conversion numbers.',
    agent: 'Keeps an append-only history of every event for each application.',
    yours: 'Outcomes are recorded only when you say so.',
    topic: 'tracking',
  },
]);

/** The two points on the journey where only a person can move things forward. */
export const GATES = Object.freeze([
  { after: 'tailor', label: 'You approve', fact: 'You check the packet', detail: 'Nothing is filled until you approve the packet. If the resume, letter or your saved answers change afterwards, the approval is withdrawn.' },
  { after: 'fill', label: 'You submit', fact: 'The click is yours', detail: 'Auto-fill ends at a filled form. The final click is yours.' },
]);

/** Illustrative postings for the Discover stage, each with the outcome the pipeline would record. */
export const DISCOVER_DEMO = Object.freeze([
  { company: 'Northwind Analytics', title: 'Senior Data Engineer', meta: 'Greenhouse, Remote, 2 days ago', outcome: 'kept', label: 'Kept for scoring' },
  { company: 'Contoso Health', title: 'Data Engineer II', meta: 'Workday, listed in 3 cities', outcome: 'merged', label: '3 copies merged into 1' },
  { company: 'Fabrikam Systems', title: 'Lead Data Engineer', meta: 'Lever, posted 62 days ago', outcome: 'dropped', label: 'Set aside: older than your window' },
  { company: 'Tailspin Defense', title: 'Data Engineer', meta: 'iCIMS, active clearance required', outcome: 'excluded', label: 'Excluded: requires a security clearance' },
  { company: 'Adventure Works', title: 'Analytics Engineer', meta: 'Ashby, no posting date', outcome: 'held', label: 'Held for review: date unknown' },
]);

/** Illustrative resume bullets for the Tailor stage. `rank` is the tailored position. */
export const TAILOR_DEMO = Object.freeze({
  wanted: ['Spark', 'Airflow', 'dbt', 'Kafka'],
  gap: 'Kafka',
  bullets: [
    { id: 'b1', rank: 3, text: 'Mentored four engineers and ran the on-call rotation.' },
    { id: 'b2', rank: 1, text: 'Rebuilt nightly batch jobs as {Spark} pipelines orchestrated in {Airflow}.' },
    { id: 'b3', rank: 4, text: 'Cut warehouse spend by retiring unused tables.' },
    { id: 'b4', rank: 2, text: 'Modelled the finance marts in {dbt} with tests on every model.' },
  ],
  skills: { master: ['SQL', 'Python', 'Power BI', 'Spark', 'Airflow', 'dbt'], tailored: ['Spark', 'Airflow', 'dbt', 'SQL', 'Python', 'Power BI'] },
});

/** Illustrative form fields for the Fill stage, in the order they are handled. */
export const FILL_DEMO = Object.freeze([
  { label: 'First name', value: 'Jordan', from: 'Profile', state: 'filled' },
  { label: 'Email', value: 'jordan@example.com', from: 'Profile', state: 'filled' },
  { label: 'Resume', value: 'Northwind_Senior-Data-Engineer.pdf', from: 'Tailored for this job', state: 'filled' },
  { label: 'Will you now or in the future require sponsorship?', value: 'Yes', from: 'Your saved answer', state: 'filled' },
  { label: 'Why do you want to work at Northwind?', value: '', from: 'No saved answer, so it asks you', state: 'ask' },
]);

/** Illustrative history for the Track stage. */
export const TRACK_DEMO = Object.freeze([
  { when: 'Mon', what: 'Auto-fill stopped at Submit', who: 'JobAgent' },
  { when: 'Mon', what: 'You submitted and confirmed it', who: 'You' },
  { when: 'Mon', what: 'Follow-up reminder set', who: 'You' },
  { when: 'Thu', what: 'Reply read from your inbox: interview invitation', who: 'JobAgent, as a suggestion' },
  { when: 'Thu', what: 'Outcome recorded: Interviewing', who: 'You' },
]);

/** What the product does on its own, and what it refuses to do. Each line is enforced in code. */
export const BOUNDARIES = Object.freeze({
  does: [
    'Runs entirely on your computer and serves its dashboard on 127.0.0.1 only.',
    'Keeps your jobs, resume, answers and history in local files and a local SQLite database.',
    'Shows the reason for every score, every discard and every stop.',
    'Builds resumes and letters only from what your master resume and profile already say.',
    'Stops and hands the browser to you the moment a page needs a human.',
  ],
  never: [
    'Submits an application without you. No command and no dashboard button does it.',
    'Solves, bypasses or works around a CAPTCHA, login, verification code or bot check.',
    'Guesses an answer to a screening question it has no saved answer for.',
    'States that you do not need sponsorship when your profile says you do.',
    'Adds a skill, number or title to your resume that is not already yours.',
    'Logs in to a job board or scrapes behind a login.',
  ],
});

/**
 * Where jobs come from. `id` is the adapter id in src/search/index.js (the test
 * checks the two lists are identical). `mode`: on = enabled in the shipped
 * config, key = needs your own API key, urls = reads only links you give it.
 */
export const SOURCE_GROUPS = Object.freeze([
  { id: 'ats', name: 'Employer ATS feeds', blurb: 'The public JSON a company’s own careers site loads. You list the boards; JobAgent reads each one.' },
  { id: 'search', name: 'Cross-company search', blurb: 'Asks a vendor’s public job search for your target titles across every employer it hosts.' },
  { id: 'careers', name: 'Company careers pages', blurb: 'Reads job links and the structured data a careers page or sitemap publishes.' },
  { id: 'aggregator', name: 'Aggregators, with your key', blurb: 'Official APIs you sign up for. Off until you add credentials.' },
  { id: 'urls', name: 'Links you supply', blurb: 'Reads the public posting at a URL you paste. No searching, no login.' },
]);

export const SOURCES = Object.freeze([
  { id: 'greenhouse', name: 'Greenhouse', group: 'ats', mode: 'on', how: 'Job Board API' },
  { id: 'lever', name: 'Lever', group: 'ats', mode: 'on', how: 'Postings API' },
  { id: 'ashby', name: 'Ashby', group: 'ats', mode: 'on', how: 'Job Posting API' },
  { id: 'smartrecruiters', name: 'SmartRecruiters', group: 'ats', mode: 'on', how: 'Posting API' },
  { id: 'workday', name: 'Workday', group: 'ats', mode: 'on', how: 'Public career-site feed' },
  { id: 'rippling', name: 'Rippling', group: 'ats', mode: 'on', how: 'Public board API' },
  { id: 'oracleRecruiting', name: 'Oracle Recruiting', group: 'ats', mode: 'on', how: 'Candidate Experience API' },
  { id: 'icims', name: 'iCIMS', group: 'ats', mode: 'on', how: 'Public career portals' },
  { id: 'amazonJobs', name: 'Amazon Jobs', group: 'ats', mode: 'on', how: 'Public search feed' },
  { id: 'atsSearch', name: 'Workable, SmartRecruiters and The Muse search', group: 'search', mode: 'on', how: 'Query by target title' },
  { id: 'careers', name: 'Careers pages and sitemaps', group: 'careers', mode: 'on', how: 'Links plus JSON-LD' },
  { id: 'adzuna', name: 'Adzuna', group: 'aggregator', mode: 'key', how: 'Official API, free developer key' },
  { id: 'apify', name: 'Apify actors', group: 'aggregator', mode: 'key', how: 'Official API, your token' },
  { id: 'manualUrls', name: 'Your links and CSV', group: 'urls', mode: 'on', how: 'Add a job by URL' },
  { id: 'genericPublicPage', name: 'Any public posting', group: 'urls', mode: 'urls', how: 'JSON-LD reader' },
  { id: 'linkedin', name: 'LinkedIn posting links', group: 'urls', mode: 'urls', how: 'Public page only' },
  { id: 'indeed', name: 'Indeed posting links', group: 'urls', mode: 'urls', how: 'Public page only' },
  { id: 'dice', name: 'Dice posting links', group: 'urls', mode: 'urls', how: 'Public page only' },
]);

export const SOURCE_MODES = Object.freeze({
  on: 'On by default',
  key: 'Needs your key',
  urls: 'Reads links you give it',
});

/**
 * The capability ledger: what is built, and how finished it is.
 * `topic` links to the Deep Dive section that explains it.
 */
export const CAPABILITIES = Object.freeze([
  { area: 'Find', name: 'Discovery from employer ATS feeds', what: 'Nine public feeds read directly, with per-host politeness limits and retries.', status: 'shipped', topic: 'discovery' },
  { area: 'Find', name: 'Cross-company title search', what: 'Searches by your target titles across employers, no key needed.', status: 'shipped', topic: 'discovery' },
  { area: 'Find', name: 'Add a job by URL', what: 'Paste any public posting; it is read, scored and tracked like the rest.', status: 'shipped', topic: 'discovery' },
  { area: 'Find', name: 'Search by job role', what: 'An ad-hoc search for a role outside your profile, kept apart from your main board.', status: 'shipped', topic: 'discovery' },
  { area: 'Find', name: 'Watch mode', what: 'Polls for new strong matches on an interval and can raise a desktop notification.', status: 'shipped', topic: 'interfaces' },
  { area: 'Find', name: 'Closed-posting sweep', what: 'Asks each ATS whether a stored posting still exists and retires the ones that do not.', status: 'shipped', topic: 'discovery' },
  { area: 'Find', name: 'Background description fetching', what: 'Reads full descriptions for postings a source listed by title only.', status: 'optional', topic: 'discovery' },
  { area: 'Find', name: 'Adzuna and Apify sources', what: 'Wider coverage through official APIs, using your own credentials.', status: 'optional', topic: 'discovery' },
  { area: 'Find', name: 'Hacker News “Who is hiring” source', what: 'A new adapter on a public API.', status: 'planned', topic: 'discovery' },

  { area: 'Match', name: 'Deterministic fit scoring', what: 'Weighted categories, tiers, and a written explanation per job.', status: 'shipped', topic: 'scoring' },
  { area: 'Match', name: 'Eligibility checks', what: 'Reads stated years, degree, licence and clearance floors and holds a job you do not meet.', status: 'shipped', topic: 'scoring' },
  { area: 'Match', name: 'Sponsorship reading', what: 'Classifies each posting as Confirmed, Likely, Unconfirmed or Denied, with the sentence that decided it.', status: 'shipped', topic: 'scoring' },
  { area: 'Match', name: 'Profiles for any profession', what: 'Search profiles built from a resume and a role-family taxonomy; several people can share one install.', status: 'shipped', topic: 'profiles' },
  { area: 'Match', name: 'Rank top matches by meaning', what: 'A second, labelled number from text embeddings. It never changes the score.', status: 'optional', topic: 'ai' },
  { area: 'Match', name: 'Weight calibration from outcomes', what: 'Proposes bounded weight changes once you have recorded enough results. You apply them.', status: 'optional', topic: 'scoring' },

  { area: 'Prepare', name: 'Resume tailoring', what: 'Reorders and emphasizes existing content in a per-job copy; produces DOCX and PDF.', status: 'shipped', topic: 'tailoring' },
  { area: 'Prepare', name: 'ATS readiness report', what: 'Keyword coverage, density band, layout problems an ATS trips on, and honest gaps.', status: 'shipped', topic: 'tailoring' },
  { area: 'Prepare', name: 'Template cover letters', what: 'Assembled from your profile and letter settings, cleaned of filler phrases.', status: 'shipped', topic: 'packets' },
  { area: 'Prepare', name: 'Document versions', what: 'Every prepared resume and letter is kept; the submitted set is frozen.', status: 'shipped', topic: 'packets' },
  { area: 'Prepare', name: 'Requirement extraction with an LLM', what: 'A model reads the posting only; every phrase must appear word for word in it.', status: 'optional', topic: 'ai' },
  { area: 'Prepare', name: 'Verified bullet rewrites', what: 'A model proposes rewordings; a deterministic verifier and then you decide.', status: 'optional', topic: 'ai' },
  { area: 'Prepare', name: 'Grounded cover letters', what: 'A model writes paragraphs that must cite your resume; unverified ones are dropped.', status: 'optional', topic: 'ai' },

  { area: 'Apply', name: 'Approval queue', what: 'Every packet waits for your approval, and the approval covers exactly what you saw.', status: 'shipped', topic: 'packets' },
  { area: 'Apply', name: 'Assisted form filling', what: 'Fills a live application in a real browser and stops before Submit.', status: 'shipped', topic: 'autofill' },
  { area: 'Apply', name: 'Answer once, reuse everywhere', what: 'A question it could not answer is queued; your answer fills every later form.', status: 'shipped', topic: 'autofill' },
  { area: 'Apply', name: 'Browser extension', what: 'Fills an approved packet in the tab you already have open. Loaded manually in Chrome or Edge.', status: 'optional', topic: 'interfaces' },
  { area: 'Apply', name: 'Final auto-submit', what: 'A server route that can click Submit under strict conditions. No dashboard button calls it, and it is refused on every ATS until one is verified live.', status: 'experimental', topic: 'autofill' },

  { area: 'Track', name: 'Applications board', what: 'Stages, outcomes, notes, follow-up reminders and conversion numbers.', status: 'shipped', topic: 'tracking' },
  { area: 'Track', name: 'Exports', what: 'CSV of every job and score, a tracker spreadsheet, and follow-ups as a calendar file.', status: 'shipped', topic: 'tracking' },
  { area: 'Track', name: 'Email replies', what: 'Reads your inbox over read-only IMAP and suggests outcomes; can draft a reply for you to send.', status: 'optional', topic: 'tracking' },
  { area: 'Track', name: 'Follow-up desktop alerts', what: 'A notification when a reminder comes due.', status: 'optional', topic: 'tracking' },
  { area: 'Track', name: 'Google Calendar sync', what: 'Writing follow-ups straight to a calendar.', status: 'planned', topic: 'tracking' },

  { area: 'Platform', name: 'Backups, export and import', what: 'Daily database snapshots and a one-file, optionally encrypted bundle of everything personal.', status: 'shipped', topic: 'data' },
  { area: 'Platform', name: 'Doctor', what: 'A preflight checklist for Node, the database, config, the resume, Python and the browser.', status: 'shipped', topic: 'interfaces' },
  { area: 'Platform', name: 'MCP server', what: 'Read access to your jobs and applications for an assistant on this computer. It cannot approve, fill or submit.', status: 'optional', topic: 'interfaces' },
  { area: 'Platform', name: 'Live run progress stream', what: 'Server-sent progress in place of polling.', status: 'planned', topic: 'interfaces' },
  { area: 'Platform', name: 'Dropped-field report on resume import', what: 'Listing what a resume import could not place.', status: 'planned', topic: 'profiles' },
]);

export const CAPABILITY_AREAS = Object.freeze(['Find', 'Match', 'Prepare', 'Apply', 'Track', 'Platform']);
