/**
 * Explore JobAgent: the Product Overview's content, as plain data.
 *
 * No DOM access, so it can be imported by tests. Everything here describes
 * behaviour that exists in this repository; `tests/node/exploreContent.test.js`
 * compares the parts that mirror code (sources, tiers, statuses, scores) with
 * the code itself, so this page cannot quietly drift from what the product does.
 *
 * The page tells one story, an application followed from a morning of postings
 * to an interview, and can tell it for six kinds of work (FIELDS). Every person,
 * employer, posting and resume line is fictional, and is labelled as an
 * illustrative example wherever it is shown.
 *
 * Written for someone who has never heard of JobAgent and may not work in
 * technology: a term the product uses is explained in plain words the first
 * time it appears.
 */

/** How finished a capability is. The four values the page distinguishes. */
export const STATUS = Object.freeze({
  shipped: { label: 'Implemented', short: 'Ready to use', note: 'Works out of the box, no extra setup.' },
  optional: { label: 'Optional', short: 'Yours to switch on', note: 'Built, and off until you turn it on or add a key.' },
  experimental: { label: 'Experimental', short: 'Built, held back', note: 'Built and tested, deliberately not offered in the dashboard.' },
  planned: { label: 'Planned', short: 'Not built yet', note: 'On the roadmap. Not built.' },
});

/** The opening statement. The headline is the product's rule in four words. */
export const HERO = Object.freeze({
  lede: 'JobAgent finds jobs in your field, shows how well each one fits, tailors your resume and fills in the application. Then it waits for you to check it and press Submit.',
  primary: 'See how it works',
  secondary: 'Open the dashboard',
  // The three things a wary reader needs to hear first, each true of the code.
  trust: [
    { line: 'find', name: 'Runs on your computer', text: 'No account to create. No cloud service.' },
    { line: 'apply', name: 'Invents nothing', text: 'Your resume is reordered, never added to.' },
    { line: 'signal', name: 'Never submits without you', text: 'It stops before Submit, every time.' },
  ],
  pick: { label: 'See it for your field', note: 'The same steps for any of 26 job families. Only the example changes.' },
});

/** How strong a match, in plain words, for each verdict the scorer can give. */
export const TIER_GLOSS = Object.freeze({
  Priority: 'A very strong match. Apply first.',
  Apply: 'A strong match. Worth applying.',
  Queue: 'A possible match. Yours to judge.',
  'Near miss': 'Close, and missing something that matters.',
  Discard: 'Not a match for this search.',
});

/**
 * The six fields the story can be told for, in the order they are offered.
 *
 * `family` is a role family in config/role_families.json. `inputs` are what the
 * scorer would read from this posting and this person; the score and verdict on
 * the page are computed from them by score-model.js, never written here.
 *
 * In `posting`, {braces} mark one of the person's eight skills (resume.skills.master)
 * found in the posting, and [brackets] mark a stated requirement the eligibility
 * check reads. In `resume`, {braces} mark a term the posting asks for, set in
 * bold on the tailored copy only. `rank` is a bullet's tailored position; 0
 * means it was left out to fit the page.
 *
 * `posting.condition` is a hidden condition as src/scoring/hiddenClauses.js reads
 * it: `tag` is the label that reader gives `sentence` (the test runs it).
 *
 * `discover` is the stream for this field: mostly its own kind of work, and one
 * posting from elsewhere in the same employer's feed that is set aside.
 */
export const FIELDS = Object.freeze([
  {
    id: 'software',
    label: 'Software Engineer',
    short: 'Software',
    kind: 'Software',
    family: 'software-engineering',
    person: { first: 'Jordan', email: 'jordan@example.com' },
    teaches: 'Evidence for each skill, and what the posting asks for beyond your profile.',
    job: { title: 'Senior Full Stack Engineer', company: 'Northwind Traders', location: 'Remote, US', via: 'Greenhouse', posted: '2 days ago' },
    inputs: { needsSponsorship: false, skillsFound: 5, skillsPreferredOnly: 1, location: 'remote', ageDays: 2 },
    discover: [
      { title: 'Senior Full Stack Engineer', company: 'Northwind Traders', kind: 'Software', meta: 'Remote, 2 days ago', outcome: 'kept', label: 'Kept for scoring' },
      { title: 'Frontend Engineer', company: 'Contoso', kind: 'Software', meta: 'Listed in 3 cities', outcome: 'merged', label: '3 copies merged into 1' },
      { title: 'Payroll Specialist', company: 'Northwind Traders', kind: 'Finance', meta: 'Same employer, another team', outcome: 'other', label: 'Set aside: a different kind of work' },
      { title: 'Backend Engineer', company: 'Fabrikam', kind: 'Software', meta: 'Posted 62 days ago', outcome: 'dropped', label: 'Set aside: older than your limit' },
      { title: 'Software Engineer II', company: 'Adventure Works', kind: 'Software', meta: 'No posting date', outcome: 'held', label: 'Held for you: date unknown' },
    ],
    posting: {
      requires: 'Build product features in {React} and {TypeScript}, with {Node.js} services on {PostgreSQL}. You are comfortable with feature flags and trunk-based development.',
      prefers: '{AWS}, Kubernetes.',
      condition: { tag: 'On-call rotation', sentence: 'Engineers join the on-call rotation one week in six.' },
    },
    evidence: [
      { skill: 'React, TypeScript', bullet: 'b2' },
      { skill: 'Node.js, PostgreSQL', bullet: 'b4' },
      { skill: 'AWS', bullet: 'b5' },
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
      skills: {
        master: ['JavaScript', 'React', 'TypeScript', 'Node.js', 'PostgreSQL', 'GraphQL', 'AWS', 'Docker'],
        tailored: ['React', 'TypeScript', 'Node.js', 'PostgreSQL', 'AWS', 'JavaScript', 'GraphQL', 'Docker'],
      },
    },
    form: { needsAccount: false, extra: { label: 'GitHub or portfolio link', kind: 'Link', value: 'github.example/jordan', from: 'Your profile' } },
  },
  {
    id: 'security',
    label: 'Cybersecurity Analyst',
    short: 'Security',
    kind: 'Security',
    family: 'security',
    person: { first: 'Dana', email: 'dana@example.com' },
    teaches: 'Conditions buried in a posting, such as a clearance or an on-site period, lifted out as tags.',
    job: { title: 'Cloud Security Engineer', company: 'Tailspin Toys', location: 'Austin TX, then remote', via: 'Lever', posted: '4 days ago' },
    inputs: { needsSponsorship: false, skillsFound: 6, skillsPreferredOnly: 1, domainMatch: true, location: 'onsite_ok', ageDays: 4 },
    discover: [
      { title: 'Cloud Security Engineer', company: 'Tailspin Toys', kind: 'Security', meta: 'Austin TX, 4 days ago', outcome: 'kept', label: 'Kept for scoring' },
      { title: 'Security Analyst', company: 'Contoso', kind: 'Security', meta: 'Listed in 3 cities', outcome: 'merged', label: '3 copies merged into 1' },
      { title: 'SOC Analyst', company: 'Woodgrove Bank', kind: 'Security', meta: 'Active Secret clearance required', outcome: 'excluded', label: 'Set aside: needs a clearance you do not hold' },
      { title: 'Accounts Payable Clerk', company: 'Tailspin Toys', kind: 'Finance', meta: 'Same employer, another team', outcome: 'other', label: 'Set aside: a different kind of work' },
      { title: 'Detection Engineer', company: 'Litware', kind: 'Security', meta: 'No posting date', outcome: 'held', label: 'Held for you: date unknown' },
    ],
    posting: {
      requires: 'Run detection and response in {Splunk} and {CrowdStrike}, harden {AWS} accounts, and own {IAM} reviews against {SOC 2}. You write policy as code.',
      prefers: '{Okta}, Kubernetes security.',
      condition: { tag: 'Onsite for the first 90 days', sentence: 'Your first 90 days are on-site at our Austin office, then remote.' },
    },
    evidence: [
      { skill: 'Splunk, CrowdStrike', bullet: 'b2' },
      { skill: 'IAM, AWS', bullet: 'b4' },
      { skill: 'SOC 2', bullet: 'b5' },
    ],
    gap: 'Kubernetes security',
    alsoAsked: ['policy as code'],
    resume: {
      role: 'Security Analyst, Fabrikam',
      summary: 'Security analyst with five years in detection, cloud hardening and audits: {AWS}, {Splunk}, {SOC 2}.',
      bullets: [
        { id: 'b1', rank: 4, text: 'Trained 60 engineers in secure coding basics.' },
        { id: 'b2', rank: 1, text: 'Built 40 {Splunk} detections and tuned {CrowdStrike}, halving false alarms.' },
        { id: 'b3', rank: 0, text: 'Wrote the monthly security awareness newsletter.' },
        { id: 'b4', rank: 2, text: 'Led quarterly {IAM} access reviews across 30 {AWS} accounts.' },
        { id: 'b5', rank: 3, text: 'Ran evidence collection for two {SOC 2} Type II audits.' },
      ],
      skills: {
        master: ['Python', 'Splunk', 'CrowdStrike', 'AWS', 'IAM', 'SOC 2', 'Okta', 'Wireshark'],
        tailored: ['Splunk', 'CrowdStrike', 'AWS', 'IAM', 'SOC 2', 'Okta', 'Python', 'Wireshark'],
      },
    },
    form: { needsAccount: false, extra: { label: 'Do you hold an active security clearance?', kind: 'Yes or no', value: 'No', from: 'Your saved answer' } },
  },
  {
    id: 'regulatory',
    label: 'Regulatory Affairs',
    short: 'Pharma',
    kind: 'Pharma and regulatory',
    family: 'regulatory-quality',
    person: { first: 'Priya', email: 'priya@example.com' },
    teaches: 'A stated number of years read from the posting. One year short costs points. It is not refused.',
    job: { title: 'Senior Regulatory Affairs Specialist, CMC', company: 'Trey Research', location: 'Hybrid, Raleigh NC', via: 'Workday', posted: '3 days ago' },
    inputs: { needsSponsorship: false, skillsFound: 5, skillsPreferredOnly: 1, domainMatch: true, eligibility: 'stretch1', location: 'onsite_ok', ageDays: 3 },
    discover: [
      { title: 'Senior Regulatory Affairs Specialist, CMC', company: 'Trey Research', kind: 'Pharma and regulatory', meta: 'Raleigh NC, 3 days ago', outcome: 'kept', label: 'Kept for scoring' },
      { title: 'Regulatory Affairs Associate', company: 'Contoso Pharma', kind: 'Pharma and regulatory', meta: 'Listed in 3 cities', outcome: 'merged', label: '3 copies merged into 1' },
      { title: 'Lab Facilities Technician', company: 'Trey Research', kind: 'Skilled trades', meta: 'Same employer, another team', outcome: 'other', label: 'Set aside: a different kind of work' },
      { title: 'Quality Assurance Specialist', company: 'Fabrikam Life Sciences', kind: 'Pharma and regulatory', meta: 'Posted 62 days ago', outcome: 'dropped', label: 'Set aside: older than your limit' },
      { title: 'Regulatory Submissions Manager', company: 'Lamna Healthcare', kind: 'Pharma and regulatory', meta: 'No posting date', outcome: 'held', label: 'Held for you: date unknown' },
    ],
    posting: {
      requires: '[6+ years] in regulatory affairs. Author {CMC} sections of {IND} submissions in {eCTD} format, including {Module 3}, and manage post-approval change assessments.',
      prefers: '{Veeva Vault}, biologics.',
      floor: 'The posting states 6 years. Your profile says 5, so a few points come off. The job is not refused.',
      condition: { tag: 'Travel up to 10%', sentence: 'Up to 10% travel to manufacturing sites.' },
    },
    evidence: [
      { skill: 'CMC, Module 3, IND', bullet: 'b2' },
      { skill: 'eCTD', bullet: 'b4' },
      { skill: 'Veeva Vault', bullet: 'b5' },
    ],
    gap: 'Biologics',
    alsoAsked: ['post-approval change assessments'],
    resume: {
      role: 'Regulatory Affairs Specialist, Fabrikam',
      summary: 'Regulatory affairs specialist with five years of {CMC} authoring for {IND} and NDA submissions in {eCTD} format.',
      bullets: [
        { id: 'b1', rank: 4, text: 'Trained three new associates on document control.' },
        { id: 'b2', rank: 1, text: 'Authored {Module 3} {CMC} sections for two {IND} submissions.' },
        { id: 'b3', rank: 0, text: 'Coordinated the department’s annual audit calendar.' },
        { id: 'b4', rank: 2, text: 'Compiled and published {eCTD} sequences for an NDA supplement.' },
        { id: 'b5', rank: 3, text: 'Tracked submission documents in {Veeva Vault}.' },
      ],
      skills: {
        master: ['FDA correspondence', 'ICH guidelines', 'CMC', 'eCTD', 'Module 3', 'IND', 'NDA', 'Veeva Vault'],
        tailored: ['CMC', 'IND', 'eCTD', 'Module 3', 'Veeva Vault', 'NDA', 'ICH guidelines', 'FDA correspondence'],
      },
    },
    form: { needsAccount: true, extra: { label: 'Years of regulatory affairs experience', kind: 'Number', value: '5', from: 'Your saved answer' } },
  },
  {
    id: 'nursing',
    label: 'Registered Nurse',
    short: 'Nursing',
    kind: 'Healthcare',
    family: 'healthcare-clinical',
    person: { first: 'Maya', email: 'maya@example.com' },
    teaches: 'A license the posting requires, checked against your profile, and shift conditions shown up front.',
    job: { title: 'Registered Nurse, ICU', company: 'Lamna Healthcare', location: 'On site, Columbus OH', via: 'Workday', posted: '1 day ago' },
    inputs: { needsSponsorship: false, skillsFound: 5, skillsPreferredOnly: 0, domainMatch: true, location: 'onsite_ok', ageDays: 1 },
    discover: [
      { title: 'Registered Nurse, ICU', company: 'Lamna Healthcare', kind: 'Healthcare', meta: 'Columbus OH, 1 day ago', outcome: 'kept', label: 'Kept for scoring' },
      { title: 'Registered Nurse, Step-Down', company: 'Contoso Health', kind: 'Healthcare', meta: 'Listed in 3 cities', outcome: 'merged', label: '3 copies merged into 1' },
      { title: 'Nurse Practitioner', company: 'Woodgrove Clinics', kind: 'Healthcare', meta: 'Nurse practitioner license required', outcome: 'excluded', label: 'Held for you: asks for a license you do not have' },
      { title: 'Hospital Billing Specialist', company: 'Lamna Healthcare', kind: 'Finance', meta: 'Same employer, another team', outcome: 'other', label: 'Set aside: a different kind of work' },
      { title: 'Travel Nurse, ICU', company: 'Adventure Works Staffing', kind: 'Healthcare', meta: 'Posted 62 days ago', outcome: 'dropped', label: 'Set aside: older than your limit' },
    ],
    posting: {
      requires: '[Active RN license] in Ohio. Provide {patient assessment} and {medication administration} for critically ill adults, chart in {Epic}, hold current {ACLS} and {BLS}, and be confident with ventilator management.',
      prefers: 'CCRN certification.',
      floor: 'The posting requires an RN license. Your profile has one, so nothing is held.',
      condition: { tag: 'Nights, weekends or rotating shifts', sentence: 'Rotating 12-hour night shifts, including every third weekend.' },
    },
    evidence: [
      { skill: 'Patient assessment, Medication administration', bullet: 'b2' },
      { skill: 'Epic', bullet: 'b4' },
      { skill: 'ACLS, BLS', bullet: 'b5' },
    ],
    gap: 'CCRN certification',
    alsoAsked: ['ventilator management'],
    resume: {
      role: 'Registered Nurse, Contoso Health',
      summary: 'Registered nurse with six years in adult critical care: {patient assessment}, {medication administration} and {Epic} charting.',
      bullets: [
        { id: 'b1', rank: 4, text: 'Precepted four nursing students each semester.' },
        { id: 'b2', rank: 1, text: 'Led {patient assessment} and {medication administration} for three critically ill adults a shift.' },
        { id: 'b3', rank: 0, text: 'Organized the unit’s annual skills fair.' },
        { id: 'b4', rank: 2, text: 'Charted in {Epic} and trained six new nurses on it.' },
        { id: 'b5', rank: 3, text: 'Kept {ACLS} and {BLS} current on the rapid response team.' },
      ],
      skills: {
        master: ['Patient assessment', 'Medication administration', 'Epic', 'ACLS', 'BLS', 'IV therapy', 'Wound care', 'Triage'],
        tailored: ['Patient assessment', 'Medication administration', 'Epic', 'ACLS', 'BLS', 'IV therapy', 'Wound care', 'Triage'],
      },
    },
    form: { needsAccount: true, extra: { label: 'Are you licensed as a Registered Nurse in Ohio?', kind: 'Yes or no', value: 'Yes', from: 'Your saved answer' } },
  },
  {
    id: 'marketing',
    label: 'Marketing Manager',
    short: 'Marketing',
    kind: 'Marketing',
    family: 'marketing-growth',
    person: { first: 'Sam', email: 'sam@example.com' },
    teaches: 'A resume reordered toward campaign and analytics work, and a portfolio link filled in for you.',
    job: { title: 'Senior Marketing Manager', company: 'Fabrikam', location: 'Remote, US', via: 'Greenhouse', posted: '5 days ago' },
    inputs: { needsSponsorship: false, skillsFound: 5, skillsPreferredOnly: 1, seniority: 'up1', location: 'remote', ageDays: 5 },
    discover: [
      { title: 'Senior Marketing Manager', company: 'Fabrikam', kind: 'Marketing', meta: 'Remote, 5 days ago', outcome: 'kept', label: 'Kept for scoring' },
      { title: 'Marketing Manager, Growth', company: 'Contoso', kind: 'Marketing', meta: 'Listed in 3 cities', outcome: 'merged', label: '3 copies merged into 1' },
      { title: 'Sales Development Representative', company: 'Fabrikam', kind: 'Sales', meta: 'Same employer, another team', outcome: 'other', label: 'Set aside: a different kind of work' },
      { title: 'Brand Manager', company: 'Adventure Works', kind: 'Marketing', meta: 'Posted 62 days ago', outcome: 'dropped', label: 'Set aside: older than your limit' },
      { title: 'Content Marketing Manager', company: 'Litware', kind: 'Marketing', meta: 'No posting date', outcome: 'held', label: 'Held for you: date unknown' },
    ],
    posting: {
      requires: 'Plan and run multi-channel campaigns end to end: {campaign strategy}, {email marketing} in {HubSpot}, and reporting in {Google Analytics}. You will own the content calendar.',
      prefers: '{A/B testing}, Salesforce.',
      condition: { tag: 'Travel up to 20%', sentence: 'Travel up to 20% for events and customer visits.' },
    },
    evidence: [
      { skill: 'Campaign strategy', bullet: 'b2' },
      { skill: 'Email marketing, HubSpot', bullet: 'b4' },
      { skill: 'Google Analytics', bullet: 'b5' },
    ],
    gap: 'Salesforce',
    alsoAsked: ['content calendar'],
    resume: {
      role: 'Marketing Manager, Proseware',
      summary: 'Marketing manager with seven years of campaigns, from {campaign strategy} to {Google Analytics} reporting.',
      bullets: [
        { id: 'b1', rank: 4, text: 'Managed a team of three and a yearly budget of $400,000.' },
        { id: 'b2', rank: 1, text: 'Led {campaign strategy} for a launch that won 1,200 qualified leads.' },
        { id: 'b3', rank: 0, text: 'Hosted the company’s monthly all-hands meeting.' },
        { id: 'b4', rank: 2, text: 'Rebuilt {email marketing} in {HubSpot}: open rates up from 18% to 27%.' },
        { id: 'b5', rank: 3, text: 'Built weekly {Google Analytics} reporting for leadership.' },
      ],
      skills: {
        master: ['Campaign strategy', 'Google Analytics', 'HubSpot', 'SEO', 'Email marketing', 'A/B testing', 'Copywriting', 'Paid social'],
        tailored: ['Campaign strategy', 'Email marketing', 'HubSpot', 'Google Analytics', 'A/B testing', 'SEO', 'Copywriting', 'Paid social'],
      },
    },
    form: { needsAccount: false, extra: { label: 'Portfolio link', kind: 'Link', value: 'samrivera.example/work', from: 'Your profile' } },
  },
  {
    id: 'finance',
    label: 'Financial Analyst',
    short: 'Finance',
    kind: 'Finance',
    family: 'finance-accounting',
    person: { first: 'Alex', email: 'alex@example.com' },
    teaches: 'An on-site job scored against a wish to work remotely. It lands as a possible match, yours to judge.',
    job: { title: 'Senior Financial Analyst', company: 'Woodgrove Bank', location: 'On site, Charlotte NC', via: 'Workday', posted: '6 days ago' },
    inputs: { needsSponsorship: false, skillsFound: 4, skillsPreferredOnly: 1, location: 'onsite_unwanted', ageDays: 6 },
    discover: [
      { title: 'Senior Financial Analyst', company: 'Woodgrove Bank', kind: 'Finance', meta: 'Charlotte NC, 6 days ago', outcome: 'kept', label: 'Kept for scoring' },
      { title: 'Financial Analyst, Planning', company: 'Contoso', kind: 'Finance', meta: 'Listed in 3 cities', outcome: 'merged', label: '3 copies merged into 1' },
      { title: 'Branch Security Officer', company: 'Woodgrove Bank', kind: 'Security', meta: 'Same employer, another team', outcome: 'other', label: 'Set aside: a different kind of work' },
      { title: 'Staff Accountant', company: 'Fabrikam', kind: 'Finance', meta: 'Posted 62 days ago', outcome: 'dropped', label: 'Set aside: older than your limit' },
      { title: 'Treasury Analyst', company: 'Tailspin Toys', kind: 'Finance', meta: 'No posting date', outcome: 'held', label: 'Held for you: date unknown' },
    ],
    posting: {
      requires: 'Own the monthly {forecasting} cycle and {variance analysis}, build {financial modeling} for new products, and present to business leads. Experience with Anaplan and month-end close.',
      prefers: '{Power BI}, CPA.',
      condition: { tag: 'Fully onsite', sentence: 'This role is on-site five days a week at our Charlotte office.' },
    },
    evidence: [
      { skill: 'Forecasting', bullet: 'b2' },
      { skill: 'Variance analysis', bullet: 'b4' },
      { skill: 'Financial modeling', bullet: 'b5' },
    ],
    gap: 'Anaplan',
    alsoAsked: ['month-end close'],
    resume: {
      role: 'Financial Analyst, Contoso',
      summary: 'Financial analyst with five years in planning: {forecasting}, {variance analysis} and {financial modeling}.',
      bullets: [
        { id: 'b1', rank: 4, text: 'Supported two acquisitions with due diligence workbooks.' },
        { id: 'b2', rank: 1, text: 'Ran the monthly {forecasting} cycle for a $60 million business unit.' },
        { id: 'b3', rank: 0, text: 'Coordinated the finance team’s volunteering day.' },
        { id: 'b4', rank: 2, text: 'Wrote {variance analysis} notes for the monthly review.' },
        { id: 'b5', rank: 3, text: 'Built the {financial modeling} for three product launches.' },
      ],
      skills: {
        master: ['Financial modeling', 'Forecasting', 'Excel', 'SQL', 'Budgeting', 'Variance analysis', 'Power BI', 'NetSuite'],
        tailored: ['Forecasting', 'Variance analysis', 'Financial modeling', 'Power BI', 'Excel', 'SQL', 'Budgeting', 'NetSuite'],
      },
    },
    form: { needsAccount: true, extra: { label: 'Can you work on site five days a week?', kind: 'Yes or no', value: 'Yes', from: 'Your saved answer' } },
  },
]);

export const DEFAULT_FIELD = FIELDS[0].id;

/** The field with this id, or the default one. */
export function fieldById(id) {
  return FIELDS.find((f) => f.id === id) ?? FIELDS[0];
}

/**
 * Other kinds of work in the morning behind the headline. With the five fields
 * not chosen, they make the crowd, so the range is seen before anything is pressed.
 */
export const HERO_EXTRAS = Object.freeze([
  { kind: 'Education', title: 'Math Teacher', company: 'Bellows College' },
  { kind: 'Design', title: 'UX Designer', company: 'Adventure Works' },
  { kind: 'Skilled trades', title: 'Electrician', company: 'City Power & Light' },
  { kind: 'Operations', title: 'Warehouse Supervisor', company: 'Wide World Importers' },
  { kind: 'People', title: 'HR Generalist', company: 'Proseware' },
  { kind: 'Data', title: 'Data Engineer', company: 'Litware' },
]);

/**
 * "What if" for the Score chapter: the same posting with one fact changed, so
 * a rule can be watched at work. Each is laid over the chosen field's inputs.
 * Sponsorship lives here: most readers never need it, and the ones who do can
 * see exactly how it is handled.
 */
export const SCORE_WHATIFS = Object.freeze([
  { id: 'this', name: 'This job', inputs: {} },
  { id: 'visa', name: 'Visa needed, posting silent', inputs: { needsSponsorship: true, sponsorship: 'Unconfirmed', skillsFound: 7, skillsPreferredOnly: 0, domainMatch: true, eligibility: 'none', seniority: 'match', location: 'remote' } },
  { id: 'floor', name: 'Requirement not met', inputs: { skillsFound: 7, skillsPreferredOnly: 0, domainMatch: true, eligibility: 'ineligible', seniority: 'match', location: 'remote' } },
  { id: 'thin', name: 'Thin match', inputs: { skillsFound: 2, skillsPreferredOnly: 1, domainMatch: false, eligibility: 'none', seniority: 'unstated', location: 'unknown', ageDays: 20, directAts: false } },
]);

/** The five reasons shown in full on the Score picture, in plain words. The rest fold into one line. */
export const SCORE_LEAD_ROWS = Object.freeze([
  { id: 'titleFit', name: 'Job title' },
  { id: 'coreSkills', name: 'Skills' },
  { id: 'seniorityFit', name: 'Level' },
  { id: 'geographyFit', name: 'Location' },
  { id: 'freshness', name: 'How recent' },
]);

/**
 * The problem the product answers, said plainly, and the one difference that
 * matters set beside the two things people already use. Each frustration is
 * crossed off by what JobAgent does about it (`fix`).
 */
export const PROBLEM = Object.freeze({
  title: 'Job hunting is mostly retyping.',
  lines: [
    { pain: 'The same job boards, every morning.', fix: 'Searched for you' },
    { pain: 'The same form, typed again.', fix: 'Typed for you' },
    { pain: 'The catch, buried in paragraph nine.', fix: 'Lifted out as a tag' },
    { pain: 'One resume, reworded for every posting.', fix: 'Reordered for each job' },
  ],
  turn: 'JobAgent takes the retyping. You keep the decisions.',
  contrast: [
    { who: 'A job board', what: 'gives you a list.', then: 'Everything after that is still yours to type.' },
    { who: 'An auto-apply bot', what: 'sends applications in your name.', then: 'You never read what went out.' },
    { who: 'JobAgent', what: 'prepares each application and shows its reasoning.', then: 'Then it waits for you.', ours: true },
  ],
});

/** The whole route in one look: the reader's own first run, before the chapters go deep. */
export const RUN = Object.freeze({
  title: 'The whole route, in one minute.',
  lede: 'Five stops and two red signals. Your posting moves on its own until it reaches a signal. Then it waits for you, exactly as it does in the dashboard.',
  note: 'An example posting. Clear each signal to let it through.',
});

/**
 * The five stages of the journey, in the order work moves through them.
 * `topic` is the section under the hood that explains the stage; `fact` is the
 * one true line printed in the sheet's corner (the test checks the number in
 * Discover's against the source registry). `beats` are the moments of the
 * stage's picture, in the order it plays them; `yours` is what stays under the
 * reader's control.
 */
export const JOURNEY = Object.freeze([
  {
    id: 'discover',
    fact: '18 sources, one list',
    name: 'Discover',
    title: 'Every job board, read for you',
    body: 'One search asks every source you switched on, merges the copies of a job into one and sets aside what you ruled out. Each decision keeps its reason.',
    beats: [
      { name: 'Arrive', text: 'Postings come in from employers’ own careers pages, a search across employers and links you paste.' },
      { name: 'Merge', text: 'The same job listed in three cities becomes one row.' },
      { name: 'Set aside', text: 'Old postings and other kinds of work step back. Each keeps its reason.' },
      { name: 'Small print', text: 'A condition buried in the posting is lifted out as a tag. Press it to read the sentence.' },
      { name: 'One list', text: 'What is left is one clean list, ready to score.' },
    ],
    yours: 'Which sources are on, how old a posting may be, and what counts as a mismatch.',
    more: 'How discovery works',
    topic: 'discovery',
  },
  {
    id: 'score',
    fact: 'Every point explained',
    name: 'Score',
    title: 'A score you can read, point by point',
    body: 'Every job gets a score out of 100 that says how strong a match it is. The same job and the same profile always give the same number, and every point shows its reason.',
    beats: [
      { name: 'Match', text: 'Your skills are found in the posting’s own words.' },
      { name: 'Add up', text: 'Title, skills, level, location and how recent it is each earn points. The number is their sum.' },
      { name: 'Decide', text: 'The total lands on one of five verdicts, from Priority to Discard.' },
      { name: 'Evidence', text: 'Each matched skill shows the line of your resume that backs it.' },
      { name: 'Also asked for', text: 'What the posting wants that your profile does not cover, quoted word for word.' },
    ],
    yours: 'What counts, and by how much, is yours to change.',
    more: 'How scoring works',
    topic: 'scoring',
  },
  {
    id: 'tailor',
    fact: 'Your words, reordered',
    name: 'Tailor',
    title: 'Your resume, reordered for this job. Never invented.',
    body: 'Each job gets its own copy of your resume, with the lines that matter most to it moved to the top. Nothing is invented, and wording changes only where you accepted a rewrite checked against your own lines.',
    beats: [
      { name: 'Read', text: 'The posting’s terms are sorted by how much it wants them.' },
      { name: 'Reorder', text: 'Your strongest lines for this job move to the top.' },
      { name: 'Emphasize', text: 'Terms the posting asks for are set in bold, only where you already wrote them.' },
      { name: 'Fit', text: 'The page count is measured, not guessed. A line left out to fit two pages is listed, never hidden.' },
      { name: 'Account', text: 'Compare with master shows every line that moved or was left out, and flags any line that is not yours.' },
    ],
    yours: 'Your master resume is opened read-only and never changed.',
    more: 'How tailoring works',
    topic: 'tailoring',
  },
  {
    id: 'fill',
    fact: 'Typed for you, in view',
    name: 'Fill',
    title: 'It types the form. Then it stops.',
    body: 'After you approve, JobAgent opens the application in a real browser window you can watch and does the typing. The last click stays yours.',
    beats: [
      { name: 'Check first', text: 'Before it starts: does this employer need an account, and which questions have no answer yet? Sign in once and every job there can be retried.' },
      { name: 'Recognize', text: 'It reads the live form and works out what each field is.' },
      { name: 'Fill and check', text: 'It types from your profile, your documents and answers you saved, then reads each field back.' },
      { name: 'Left for you', text: 'A question with no saved answer is left for you, never guessed.' },
      { name: 'Stop', text: 'It stops before Submit, and at once for a sign-in, a CAPTCHA or a verification code.' },
    ],
    yours: 'You read the form and you press Submit.',
    more: 'How form filling works',
    topic: 'autofill',
  },
  {
    id: 'track',
    fact: 'Nothing slips',
    name: 'Track',
    title: 'After you apply, nothing slips',
    body: 'Once you confirm an application went in, every step is kept: outcomes, follow-ups and replies. Today shows what needs you next.',
    beats: [
      { name: 'Record', text: 'Each step lands in a history that is only ever added to.' },
      { name: 'Remind', text: 'A follow-up comes due on Today, the one screen of what needs you now.' },
      { name: 'Reply', text: 'Connect an inbox and replies are read, never changed, and suggested as outcomes.', status: 'optional' },
      { name: 'Move forward', text: 'You confirm the outcome, and the application moves to its next stage.' },
    ],
    yours: 'Outcomes are recorded only when you say so.',
    more: 'How tracking works',
    topic: 'tracking',
  },
]);

/**
 * The two points on the journey where only a person can move things forward.
 * `checks` is what the person has in front of them at the signal, `action` the
 * one thing only they can press, and `done` what is true once they have.
 */
export const GATES = Object.freeze([
  {
    after: 'tailor', label: 'You approve', fact: 'You check everything first',
    detail: 'Nothing is filled until you approve the resume, the letter and the answers for this job. Change any of them afterwards and the approval is withdrawn.',
    checks: ['Resume, tailored for this job', 'Cover letter, from your master letter', 'Answers to this form’s questions'],
    action: 'Approve', done: 'Approved by you',
  },
  {
    after: 'fill', label: 'You submit', fact: 'The click is yours',
    detail: 'Form filling ends at a filled form. You read it and press Submit. A click is not proof: it counts as applied only when a confirmation is seen.',
    checks: ['Every field filled and read back', 'The open question, answered by you', 'Your tailored resume, attached'],
    action: 'Submit application', done: 'Confirmation seen. Applied.',
  },
]);

/** The stages an application can be recorded at, in order, and where the example ends up. */
export const TRACK_STAGES = Object.freeze({ names: ['Awaiting response', 'Interviewing', 'Offer', 'Hired'], from: 0, to: 1 });

/** The history for the Track picture. `beat` is the moment of the scene the event belongs to. */
export const TRACK_DEMO = Object.freeze([
  { when: 'Mon', what: 'Form filling stopped before Submit', who: 'JobAgent', beat: 0 },
  { when: 'Mon', what: 'You submitted, and confirmed it', who: 'You', beat: 0 },
  { when: 'Thu', what: 'Follow-up came due on Today', who: 'JobAgent', beat: 1 },
  { when: 'Thu', what: 'A reply was read from your inbox: interview invitation', who: 'JobAgent, as a suggestion', beat: 2 },
  { when: 'Thu', what: 'Outcome recorded: Interviewing', who: 'You', beat: 3 },
]);

/** What the product does on its own, and what it refuses to do. Each line is enforced in code. */
export const BOUNDARIES = Object.freeze({
  does: [
    'Runs on your computer and shows its dashboard to this computer only.',
    'Keeps your jobs, resume, answers and history in ordinary files here. They are not encrypted, so keep your disk encryption on.',
    'Shows the reason for every score, every job set aside and every stop.',
    'Builds resumes and letters only from what your master resume and profile already say.',
    'Stops and hands the browser to you the moment a page needs a person.',
  ],
  never: [
    'Submits an application without you. No command and no dashboard button does it.',
    'Solves, bypasses or works around a CAPTCHA, sign-in, verification code or bot check.',
    'Guesses an answer to a screening question it has no saved answer for.',
    'States that you do not need sponsorship when your profile says you do.',
    'Adds a skill, number or title to your resume that is not already yours.',
    'Signs in to a job board, or reads anything behind a sign-in.',
  ],
});

/**
 * Where jobs come from. `id` is the adapter id in src/search/index.js (the test
 * checks the two lists are identical). `mode`: on = enabled in the shipped
 * config, key = needs your own API key, urls = reads only links you give it.
 */
export const SOURCE_GROUPS = Object.freeze([
  { id: 'ats', name: 'Employers’ application systems' },
  { id: 'search', name: 'Search across employers' },
  { id: 'careers', name: 'Company careers pages' },
  { id: 'aggregator', name: 'Job search services' },
  { id: 'urls', name: 'Links you supply' },
]);

export const SOURCES = Object.freeze([
  { id: 'greenhouse', name: 'Greenhouse', group: 'ats', mode: 'on', how: '' },
  { id: 'lever', name: 'Lever', group: 'ats', mode: 'on', how: '' },
  { id: 'ashby', name: 'Ashby', group: 'ats', mode: 'on', how: '' },
  { id: 'smartrecruiters', name: 'SmartRecruiters', group: 'ats', mode: 'on', how: '' },
  { id: 'workday', name: 'Workday', group: 'ats', mode: 'on', how: '' },
  { id: 'rippling', name: 'Rippling', group: 'ats', mode: 'on', how: '' },
  { id: 'oracleRecruiting', name: 'Oracle Recruiting', group: 'ats', mode: 'on', how: '' },
  { id: 'icims', name: 'iCIMS', group: 'ats', mode: 'on', how: '' },
  { id: 'amazonJobs', name: 'Amazon Jobs', group: 'ats', mode: 'on', how: '' },
  { id: 'atsSearch', name: 'Job-title search across employers', group: 'search', mode: 'on', how: 'Workable, SmartRecruiters and The Muse' },
  { id: 'careers', name: 'Company careers pages', group: 'careers', mode: 'on', how: 'Links and the page’s own job data' },
  { id: 'adzuna', name: 'Adzuna', group: 'aggregator', mode: 'key', how: 'Official API, free key' },
  { id: 'apify', name: 'Apify', group: 'aggregator', mode: 'key', how: 'Official API, billed to you per use' },
  { id: 'manualUrls', name: 'Links and lists you add', group: 'urls', mode: 'on', how: 'Add a job by link' },
  { id: 'genericPublicPage', name: 'Any public posting', group: 'urls', mode: 'urls', how: 'Read once, as a visitor sees it' },
  { id: 'linkedin', name: 'LinkedIn', group: 'urls', mode: 'urls', how: 'Public posting links only' },
  { id: 'indeed', name: 'Indeed', group: 'urls', mode: 'urls', how: 'Public posting links only' },
  { id: 'dice', name: 'Dice', group: 'urls', mode: 'urls', how: 'Public posting links only' },
]);

/** The three things a reader has to do, or not do, to get postings from a source. */
export const SOURCE_MODES = Object.freeze({
  on: 'On already',
  key: 'Needs your key',
  urls: 'Links you give it',
});

export const SOURCE_NOTES = Object.freeze({
  title: 'Where the jobs come from',
  lede: 'Public pages only. JobAgent never signs in to a job board and never reads anything behind a sign-in.',
  on: 'Nothing to set up. A search asks each of these.',
  key: 'Wider coverage through official services. Off until you add your own key.',
  urls: 'Paste a link and that one posting is read. These sites are never searched.',
});

/**
 * Under the hood, in four facts. Each restates a row of the technology stack
 * (content-deep.js, STACK).
 */
export const HOOD = Object.freeze({
  title: 'Plain parts, all on your computer',
  body: 'No cloud account and no hosted service. One local program, one database file per person, and code you can read.',
  facts: [
    { name: 'One local program', text: 'A small server that answers this computer only.' },
    { name: 'One database file per person', text: 'Your jobs, scores and history, with daily snapshots.' },
    { name: 'A browser window you can watch', text: 'The same kind of window you use, driven in plain view.' },
    { name: 'A resume engine', text: 'It edits a copy of your Word file and keeps its formatting.' },
  ],
  cta: 'See how it is built',
});

/**
 * The capability register: what is built, and how finished it is. Each entry
 * says what it does, why it matters and how it works, in a line each. `topic`
 * links to the section under the hood that explains it; `fresh` marks what
 * arrived in version 0.2.3 or later.
 */
export const CAPABILITY_AREAS = Object.freeze(['Find', 'Match', 'Prepare', 'Apply', 'Track', 'Platform']);

export const AREA_NAMES = Object.freeze({
  Find: 'Find jobs', Match: 'Understand your fit', Prepare: 'Prepare', Apply: 'Apply', Track: 'Track', Platform: 'Your data and setup',
});

const cap = (area, name, status, topic, what, why, how, fresh = false) => Object.freeze({ area, name, status, topic, what, why, how, fresh });

export const CAPABILITIES = Object.freeze([
  cap('Find', 'Employers’ application systems', 'shipped', 'discovery',
    'Reads the job listings of nine application systems employers use, such as Greenhouse, Workday and Lever.',
    'You stop opening the same careers pages every morning.',
    'Each employer’s public listing is asked directly, politely and with retries. Nothing is read from behind a sign-in.'),
  cap('Find', 'Search across employers', 'shipped', 'discovery',
    'Searches by your job titles across many employers at once. No key needed.',
    'It finds employers you did not know to look at.',
    'Asks the public job search of Workable, SmartRecruiters and The Muse for each title in your profile.'),
  cap('Find', 'Add a job by link', 'shipped', 'discovery',
    'Paste the link to any public posting.',
    'A job a friend sent you gets the same score, resume and tracking as the rest.',
    'The page is read once, as a visitor would see it. LinkedIn, Indeed and Dice are read only this way, never searched.'),
  cap('Find', 'Search by job role', 'shipped', 'discovery',
    'A one-off search for a role outside your profile.',
    'You can look at a neighbouring career without disturbing your main list.',
    'Results are kept apart from your main board.'),
  cap('Find', 'Watch for new matches', 'shipped', 'interfaces',
    'Repeats your search on a timer and can notify you of a strong new match.',
    'A posting gets the most attention in its first days.',
    'Runs the same search at an interval you set and can raise a desktop notification.'),
  cap('Find', 'Closed-posting sweep', 'shipped', 'discovery',
    'Retires postings that have been taken down.',
    'You do not tailor a resume for a job that is gone.',
    'Asks each application system whether a saved posting still exists.'),
  cap('Find', 'Skip unchanged listings', 'shipped', 'discovery',
    'An employer listing that has not changed since last time is skipped.',
    'Searches finish sooner.',
    'Compares the listing’s total and first page with the last search, with a full sweep every 3 days. Workday listings only, so far.', true),
  cap('Find', 'Daily scheduled search', 'optional', 'interfaces',
    'Runs a search every day through your computer’s own scheduler.',
    'Fresh matches are waiting when you sit down.',
    'One command adds the schedule. It searches and scores only, and never fills or submits.', true),
  cap('Find', 'Full descriptions in the background', 'optional', 'discovery',
    'Reads the full description of postings that were listed by title only.',
    'A score needs the posting’s own words.',
    'Fetches a few at a time from the same public pages.'),
  cap('Find', 'More sources, with your key', 'optional', 'discovery',
    'Adzuna and Apify, through their official services.',
    'Wider coverage, if you want it.',
    'Off until you add your own key. Adzuna’s key is free; Apify bills you per use.'),
  cap('Find', 'Results while a search runs', 'planned', 'interfaces',
    'Jobs appearing on the board before a search has finished.',
    'You could start reading sooner.',
    'Not built. Today the board updates when a search ends, with a count per source along the way.'),
  cap('Find', 'Hacker News “Who is hiring”', 'planned', 'discovery',
    'One more source, from a public monthly thread.',
    'Smaller employers often post only there.',
    'Not built.'),

  cap('Match', 'Fit score with reasons', 'shipped', 'scoring',
    'A score out of 100 for every job, with each point explained.',
    'You can see why a job ranks where it does, and disagree with it.',
    'Plain arithmetic over your profile and the posting. The same inputs always give the same number, and no AI model is involved.'),
  cap('Match', 'Requirement checks', 'shipped', 'scoring',
    'Reads the years, degree, license and clearance a posting states.',
    'A job you cannot hold does not sit at the top of your list.',
    'Missing a requirement by a year takes points off. One you clearly do not meet holds the job for you, with the reason.'),
  cap('Match', 'Hidden conditions', 'shipped', 'scoring',
    'Lifts out conditions buried in the text: on-call, shifts, travel, clearance, on-site periods and more.',
    'The catch is in view before you spend an evening on the application.',
    'Eleven kinds are recognized. Each tag opens to the sentence it came from.'),
  cap('Match', 'Evidence for each skill', 'shipped', 'scoring',
    'Shows the line of your resume behind each skill a posting asks for.',
    'You know what backs a match, and what does not.',
    'One rule decides evidence for the score, the application and the gap list, so the three cannot disagree.', true),
  cap('Match', 'Also asked for', 'shipped', 'scoring',
    'Lists what postings require that JobAgent does not look for yet, quoted word for word.',
    'You find out what employers ask for that your profile misses.',
    'Ranked by how many postings ask. “Look for this skill” adds one to your profile.', true),
  cap('Match', 'Sponsorship reading', 'shipped', 'scoring',
    'Reads whether a posting offers visa sponsorship.',
    'If you need it, you are not sent to employers who say no.',
    'Each posting is read as Confirmed, Likely, Unconfirmed or Denied, with the sentence that decided it. A strong match with no answer waits for you.'),
  cap('Match', 'Employer history', 'shipped', 'discovery',
    'Shows what an employer has posted before.',
    'You can tell a steady employer from a one-off listing.',
    'Built from postings you already saved. Nothing new is fetched.'),
  cap('Match', 'Profiles for 26 job families', 'shipped', 'profiles',
    'A search profile built from your resume, for any of 26 families of work.',
    'It is not a technology-only tool, and several people can share one copy.',
    'Your titles and skills are matched against one shared table of families. Every family runs through the same code.'),
  cap('Match', 'Rank by meaning', 'optional', 'ai',
    'A second, labelled number that compares meaning, not matching words.',
    'It catches a good match that uses different words from yours.',
    'Uses a model you switch on. It sits beside the score and never changes it.'),
  cap('Match', 'Tuning from your results', 'optional', 'scoring',
    'Suggests small changes to what counts in the score.',
    'The score can learn from which applications got replies.',
    'Proposes bounded changes once you have recorded enough outcomes. You apply them, or not.'),

  cap('Prepare', 'Resume tailoring', 'shipped', 'tailoring',
    'A copy of your resume for each job, with the most relevant lines first.',
    'Each employer sees your best evidence for their job, and you reword nothing.',
    'Reorders and emphasizes what is already there, in your own Word file. Your master resume is never changed.'),
  cap('Prepare', 'Resume check on upload', 'shipped', 'tailoring',
    'Tells you what JobAgent understood from your resume.',
    'You catch a misread section before fifty applications go out.',
    'Lists the sections, jobs, bullets and contact details it found, and what it could not read.', true),
  cap('Prepare', 'Measured page fit', 'shipped', 'tailoring',
    'Keeps the tailored resume to two pages.',
    'No guessing whether it spilled onto a third.',
    'The document is rendered and its pages counted when LibreOffice is installed; otherwise it is estimated from your styles. Lines left out are listed.', true),
  cap('Prepare', 'PDF from your own Word file', 'shipped', 'tailoring',
    'The PDF is your document, with your fonts and layout.',
    'What the employer opens is what you approved.',
    'Made from the tailored Word file itself.', true),
  cap('Prepare', 'Compare with master', 'shipped', 'tailoring',
    'Every line that moved, was reworded or was left out.',
    'You can check a tailored resume in a minute.',
    'A line-by-line comparison with your master resume. Mark a left-out line Keep and the next tailoring keeps it.'),
  cap('Prepare', 'One failed step, undone alone', 'shipped', 'tailoring',
    'A tailoring step that fails is undone on its own.',
    'One awkward table does not cost you the whole tailored resume.',
    'Each step is checked. A failed one is rolled back and the rest are kept.', true),
  cap('Prepare', 'Application-system check', 'shipped', 'tailoring',
    'Checks a tailored resume against what employers’ systems trip on.',
    'A resume their software cannot read does not get seen.',
    'Reports which of the posting’s terms are covered, layout problems, and honest gaps.'),
  cap('Prepare', 'Your cover letter, with versions', 'shipped', 'packets',
    'One letter you own, adapted for each job.',
    'Letters sound like you, not like a template.',
    'Built from your master letter and profile. Every version is kept and the one you sent is frozen.'),
  cap('Prepare', 'Posting read by a model', 'optional', 'ai',
    'A model picks out what a posting requires.',
    'Unusual wording is less likely to be missed.',
    'The model sees the posting only. Every phrase it returns must appear in the posting word for word.'),
  cap('Prepare', 'Checked rewrites', 'optional', 'ai',
    'A model suggests tighter wording for a resume line.',
    'Sharper lines that are still true.',
    'A checker compares each suggestion with your own line, and then you accept or reject it.'),
  cap('Prepare', 'Letters drafted from your resume', 'optional', 'ai',
    'A model drafts cover letter paragraphs.',
    'A stronger first draft to edit.',
    'Each paragraph must point to a line of your resume. Any that cannot be verified is dropped.'),

  cap('Apply', 'Approval queue', 'shipped', 'packets',
    'Everything for one application waits for your approval.',
    'Nothing goes out under your name unread.',
    'The approval covers exactly the resume, letter and answers you saw. Change any of them and it is withdrawn.'),
  cap('Apply', 'Ready-to-fill check', 'shipped', 'autofill',
    'Says, before filling, whether the employer needs an account and which questions have no answer.',
    'No surprises half way down a form.',
    'Read from the employer’s application system and from the answers you have saved.'),
  cap('Apply', 'Assisted form filling', 'shipped', 'autofill',
    'Fills the live application in a browser window you can watch.',
    'The retyping is done for you.',
    'It works out what each field is, fills it from your profile, documents and saved answers, reads it back, and stops before Submit.'),
  cap('Apply', 'Work history and education', 'shipped', 'autofill',
    'Fills the repeated work and education sections of a form.',
    'They are the longest part of most applications.',
    'Tested on a test page only so far, not yet on a live employer site.', true),
  cap('Apply', 'Answer once, reuse everywhere', 'shipped', 'autofill',
    'A question with no saved answer is asked once.',
    'You never answer the same screening question twice.',
    'Answers are kept for each person and fill every later form. It never guesses one.'),
  cap('Apply', 'Sign in once, retry all', 'shipped', 'autofill',
    'Jobs stopped at an employer’s sign-in are grouped together.',
    'One sign-in, not ten.',
    'You sign in once in the browser window. One button then retries every job at that employer.'),
  cap('Apply', 'Dry run', 'shipped', 'autofill',
    'Shows what would be filled, and changes nothing.',
    'You can rehearse on a real form safely.',
    'It reads the page, opens no menu, types nothing and stops on the first page.', true),
  cap('Apply', 'Drafted answers to open questions', 'optional', 'ai',
    'A model drafts an answer to a question like “Why this company?”',
    'A blank box is the slowest part of a form.',
    'It refuses questions of fact, such as pay or eligibility. You approve each answer, for that job only.', true),
  cap('Apply', 'Wait at a sign-in', 'optional', 'autofill',
    'Waits while you clear a sign-in or CAPTCHA yourself, then carries on.',
    'You do not start the form again.',
    'Off by default. It waits up to 15 minutes in a visible window and never solves the check.', true),
  cap('Apply', 'Several applications at once', 'optional', 'interfaces',
    'Fills up to three applications side by side.',
    'A batch finishes sooner.',
    'From the command line only, and never two at one employer. The dashboard fills one at a time.', true),
  cap('Apply', 'Browser extension', 'optional', 'interfaces',
    'Fills an approved application in the tab you already have open.',
    'For sites where you would rather use your own browser.',
    'Loaded by hand in Chrome or Edge and paired with a code.'),
  cap('Apply', 'Coverage check', 'experimental', 'autofill',
    'Reads one application page and reports which questions could be filled.',
    'It shows how well a system is covered before you rely on it.',
    'Saved pages only. No live employer site has been checked this way.'),
  cap('Apply', 'Final auto-submit', 'experimental', 'autofill',
    'A route that could press Submit under strict conditions.',
    'It is listed so you know it exists, and that it is switched off.',
    'No dashboard button calls it, and it is refused on every application system until a supervised live run is recorded. None is.'),

  cap('Track', 'Applications board', 'shipped', 'tracking',
    'Every application by stage, with notes and outcomes.',
    'One place to see where everything stands.',
    'Each step is added to a history that is never rewritten.'),
  cap('Track', 'Today', 'shipped', 'tracking',
    'The one screen of what needs you now.',
    'You open one view, not five.',
    'Approvals waiting, follow-ups due and employers waiting on a sign-in.'),
  cap('Track', 'What gets interviews', 'shipped', 'tracking',
    'Outcomes by kind of job and by resume.',
    'It shows what is working.',
    'Counts replies, interviews and offers once you have recorded some. Small groups show counts only.', true),
  cap('Track', 'Interview prep pack', 'shipped', 'tracking',
    'One printable page for an interview.',
    'You walk in with the posting and your evidence side by side.',
    'Quoted from the posting and your resume. No AI model writes it.', true),
  cap('Track', 'Exports', 'shipped', 'tracking',
    'A spreadsheet of every job and score, a tracker, and follow-ups as a calendar file.',
    'Your data is yours to take elsewhere.',
    'Written as ordinary files on your computer.'),
  cap('Track', 'Email replies', 'optional', 'tracking',
    'Reads replies from employers and suggests an outcome.',
    'An interview invitation does not sit unnoticed.',
    'Connects to your inbox read-only. You confirm each outcome.'),
  cap('Track', 'Follow-up alerts', 'optional', 'tracking',
    'A desktop notification when a follow-up comes due.',
    'A reminder you do not have to remember to check.',
    'Off until you turn it on.'),
  cap('Track', 'Google Calendar sync', 'planned', 'tracking',
    'Follow-ups written straight to your calendar.',
    'One less place to look.',
    'Not built. Today follow-ups export as a calendar file.'),

  cap('Platform', 'Everything stays here', 'shipped', 'data',
    'Your jobs, resume, answers and history live in the JobAgent folder on this computer.',
    'No account to create, and no copy of your resume in someone’s cloud.',
    'Ordinary files and one database per person. They are not encrypted, so keep your disk encryption on.'),
  cap('Platform', 'Your identity kept from AI', 'shipped', 'ai',
    'Lines with your name, email, phone or profile link are removed before any model call.',
    'A model you switch on never learns who you are.',
    'No model is used unless you turn one on. A model running on your own computer keeps everything here.', true),
  cap('Platform', 'One setup step', 'shipped', 'profiles',
    'The launcher sets up what it needs, and one card shows what is left before applying.',
    'No hunting for installers, and no wall of warnings.',
    'It offers to set up the resume engine and the browser on first launch. Searching and scoring work in the meantime.', true),
  cap('Platform', 'Backups, export and import', 'shipped', 'data',
    'Daily snapshots, and one file holding everything personal.',
    'You can move to a new computer, or recover from a mistake.',
    'The export file can be locked with a password.'),
  cap('Platform', 'Sign out everywhere', 'shipped', 'security',
    'Removes the saved employer sign-ins for one person.',
    'You can hand the laptop on without leaving sessions behind.',
    'Deletes that person’s browser folders after you confirm.', true),
  cap('Platform', 'Keyboard and command palette', 'shipped', 'interfaces',
    'Every action from the keyboard.',
    'Sorting a long list goes quickly.',
    'A palette of commands, and keys to judge jobs one by one.'),
  cap('Platform', 'Health check', 'shipped', 'interfaces',
    'A checklist that says what is wrong when something is.',
    'You are told what to fix, in plain words.',
    'Checks the database, your resume, the resume engine and the browser.'),
  cap('Platform', 'Assistant access', 'optional', 'interfaces',
    'Lets an assistant on this computer read your jobs.',
    'You can ask about your search in plain words.',
    'It can read, add a note and record an outcome. It cannot approve, fill or submit.'),
  cap('Platform', 'Packaged installer', 'planned', 'interfaces',
    'A download you double-click.',
    'Starting would take one step.',
    'Not built. Today you start JobAgent with a launcher script.'),
]);

/** What a newcomer asks before trusting a tool with their job search. Each answer is backed by code or docs. */
export const FAQ = Object.freeze([
  { q: 'Does it apply for me automatically?',
    a: 'No. It fills the form in a browser window you can see and stops before Submit. You read it and press the button. A route that could submit exists in the code; no button calls it, and it is refused on every application system until a supervised live run is recorded. None is.' },
  { q: 'Where does my data go? Is any of it sent to an AI?',
    a: 'It stays in the JobAgent folder on your computer, as ordinary files that are not encrypted, so keep your disk encryption on. No AI model is used unless you switch one on. If you do, lines with your name, email, phone or profile link are removed first.' },
  { q: 'Is it only for tech jobs?',
    a: 'No. A search profile is built from your resume against 26 families of work, from healthcare and teaching to skilled trades, and every family runs through the same code.' },
  { q: 'What do I need to start?',
    a: 'A computer and your resume as a Word file. JobAgent runs on Node.js. Python adds resume tailoring and a browser download adds form filling; the launcher offers to set both up.' },
  { q: 'Does it cost anything?',
    a: 'No. JobAgent is free and open source, and the sources that are on by default need no key. Optional extras use your own accounts: Apify bills per use, Adzuna has a free key, and a hosted AI model bills your own key.' },
  { q: 'What if it gets something wrong?',
    a: 'You see it before it matters. Every score lists its reasons, Compare with master shows every resume line that moved or was left out, a question with no saved answer is asked rather than guessed, and nothing is filled until you approve.' },
  { q: 'Which job sites does it cover?',
    a: 'Out of the box: nine application systems employers use, a job-title search across employers, company careers pages and any link you paste. Adzuna and Apify work with your own key. LinkedIn, Indeed and Dice are read only from links you give it; they are never searched and never signed in to.' },
]);

/** The next five minutes, as the dashboard really asks for them. */
export const CLOSE = Object.freeze({
  title: 'It is already running on this computer.',
  lede: 'This page came from the same local program that runs your job search. Your first search is three steps away.',
  steps: [
    { name: 'Add your resume', text: 'JobAgent builds your search profile from it.' },
    { name: 'Confirm the job titles', text: 'It proposes them. You keep, change or add.' },
    { name: 'Run your first search', text: 'Scored matches arrive with their reasons.' },
  ],
  after: 'From there, every application waits for you.',
  cta: 'Open the dashboard',
});

/**
 * What Compare with master would report for a field's tailored resume, by the
 * rules of src/resume/resumeDiff.js: lines still in their common order are
 * unchanged, a line with the same words outside that order has moved, a list
 * holding the same items in another order is reordered. The content test runs
 * the real comparison on the same lines and fails if the two disagree.
 */
export function tailorLines(field) {
  const r = field.resume;
  const kept = r.bullets.filter((b) => b.rank > 0).sort((a, b) => a.rank - b.rank);
  return {
    master: [r.role, plain(r.summary), ...r.bullets.map((b) => plain(b.text)), `Skills: ${r.skills.master.join(', ')}`],
    tailored: [r.role, plain(r.summary), ...kept.map((b) => plain(b.text)), `Skills: ${r.skills.tailored.join(', ')}`],
    omitted: r.bullets.filter((b) => b.rank === 0).map((b) => plain(b.text)),
  };
}

export function tailorLedger(field) {
  const { master, tailored, omitted } = tailorLines(field);
  // Longest common subsequence: the lines both documents hold in the same order.
  const n = master.length; const m = tailored.length;
  const t = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) t[i][j] = master[i] === tailored[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const inOrder = new Set();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (master[i] === tailored[j]) { inOrder.add(master[i]); i += 1; j += 1; } else if (t[i + 1][j] >= t[i][j + 1]) i += 1; else j += 1;
  }
  const moved = tailored.filter((line) => !inOrder.has(line) && master.includes(line));
  const skillsReordered = !inOrder.has(tailored[m - 1]) && !master.includes(tailored[m - 1]);
  return { same: inOrder.size, moved: moved.length, movedLines: moved, reordered: skillsReordered ? 1 : 0, reworded: 0, omitted: omitted.length, added: 0 };
}

/** Terms in a string marked with {braces}, in order. */
export function marks(text) {
  return [...String(text).matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

/** A string with its {braces} and [brackets] removed: the words as a reader sees them. */
export function plain(text) {
  return String(text).replace(/[{}[\]]/g, '');
}
