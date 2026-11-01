/**
 * Representative candidates and postings across industries and career stages,
 * for end-to-end matching checks (profile -> activate -> exclude -> score ->
 * tier). Fictional people; every posting is synthetic.
 *
 * Each persona names the postings it SHOULD rank as a fit (`fits`) and those
 * it must NOT (`notFits`). The traps are deliberate: a nurse recruiter is not
 * a nurse, an executive assistant is not an executive, and data entry is not
 * data engineering.
 */

const FRESH = () => new Date(Date.now() - 2 * 864e5).toISOString();

const intent = (over) => ({
  workModes: ['remote', 'hybrid', 'onsite'],
  employmentTypes: ['Full-time'],
  locations: ['United States'],
  workAuthorization: { status: 'US Citizen', requiresSponsorship: false },
  ...over,
});

const RAW_PERSONAS = [
  {
    id: 'nurse', label: 'ICU Registered Nurse',
    background: {
      currentRoles: ['Registered Nurse'], yearsExperience: 6, seniority: 'senior',
      skills: ['ACLS', 'BLS', 'Epic EHR', 'Patient Assessment', 'IV Therapy', 'Critical Care', 'Ventilator Management', 'Triage'],
      industries: ['Healthcare'], certifications: ['RN', 'CCRN'],
      education: [{ degree: 'BSN', field: 'Nursing' }],
    },
    searchIntent: intent({ targetRoles: ['ICU Nurse', 'Registered Nurse'], seniority: 'senior' }),
    fits: ['rn-icu'], notFits: ['nurse-recruiter', 'data-engineer', 'accountant-senior'],
  },
  {
    id: 'accountant', label: 'Senior Accountant',
    background: {
      currentRoles: ['Senior Accountant'], earlierRoles: ['Staff Accountant'], yearsExperience: 7, seniority: 'senior',
      skills: ['GAAP', 'Month-End Close', 'Account Reconciliation', 'NetSuite', 'Excel', 'Financial Reporting', 'Audit', 'Accruals'],
      industries: ['Financial Services'], certifications: ['CPA'],
      education: [{ degree: 'BS', field: 'Accounting' }],
    },
    searchIntent: intent({ targetRoles: ['Senior Accountant', 'Accounting Manager'], seniority: 'senior' }),
    fits: ['accountant-senior'], notFits: ['ap-clerk-entry', 'data-entry', 'software-engineer'],
  },
  {
    id: 'pm', label: 'Construction Project Manager',
    background: {
      currentRoles: ['Project Manager'], yearsExperience: 10, seniority: 'senior',
      skills: ['Project Scheduling', 'Budget Management', 'Procore', 'Stakeholder Management', 'Risk Management', 'Contract Negotiation', 'OSHA', 'MS Project'],
      industries: ['Construction'], certifications: ['PMP'],
      leadership: { hasManaged: true, evidence: ['Led site teams of 40'] },
    },
    searchIntent: intent({ targetRoles: ['Construction Project Manager', 'Project Manager'], seniority: 'senior' }),
    fits: ['construction-pm'], notFits: ['electrician', 'executive-assistant'],
  },
  {
    id: 'swe', label: 'Backend Software Engineer',
    background: {
      currentRoles: ['Software Engineer'], yearsExperience: 5, seniority: 'mid',
      skills: ['Go', 'Python', 'PostgreSQL', 'Kubernetes', 'gRPC', 'Distributed Systems', 'AWS', 'REST APIs'],
      industries: ['Technology'],
    },
    searchIntent: intent({ targetRoles: ['Backend Engineer', 'Software Engineer'], seniority: 'senior' }),
    fits: ['software-engineer'], notFits: ['data-entry', 'nurse-recruiter'],
  },
  {
    id: 'exec', label: 'VP of Operations',
    background: {
      currentRoles: ['Vice President of Operations'], earlierRoles: ['Director of Operations'], yearsExperience: 18, seniority: 'executive',
      skills: ['P&L Management', 'Operational Excellence', 'Lean Six Sigma', 'Supply Chain Strategy', 'Executive Leadership', 'Budgeting', 'M&A Integration'],
      industries: ['Manufacturing'],
      leadership: { hasManaged: true, evidence: ['Led 600-person organization'] },
    },
    searchIntent: intent({ targetRoles: ['VP of Operations', 'Chief Operating Officer'], seniority: 'executive' }),
    fits: ['vp-operations'], notFits: ['executive-assistant', 'ap-clerk-entry'],
  },
  {
    id: 'newgrad', label: 'Entry-level Marketing',
    background: {
      currentRoles: [], yearsExperience: null, seniority: 'entry',
      skills: ['Social Media Marketing', 'Content Writing', 'Canva', 'Google Analytics', 'Email Marketing', 'SEO'],
      industries: [], education: [{ degree: 'BA', field: 'Communications', graduationYear: '2026' }],
    },
    searchIntent: intent({ targetRoles: ['Marketing Coordinator', 'Marketing Assistant'], seniority: 'entry' }),
    fits: ['marketing-coordinator'], notFits: ['vp-operations', 'data-engineer'],
  },
  {
    id: 'changer', label: 'Teacher to Instructional Designer',
    background: {
      currentRoles: ['High School Teacher'], yearsExperience: 9, seniority: 'mid',
      skills: ['Curriculum Development', 'Lesson Planning', 'Articulate Storyline', 'Learning Management Systems', 'Assessment Design', 'Adult Learning'],
      industries: ['Education'],
    },
    // Wants a DIFFERENT job than the one held: the search intent leads.
    searchIntent: intent({ targetRoles: ['Instructional Designer', 'Learning Experience Designer'], seniority: 'mid', skillsToGrow: ['ADDIE', 'eLearning'] }),
    fits: ['instructional-designer'], notFits: ['software-engineer', 'accountant-senior'],
  },
  {
    id: 'electrician', label: 'Journeyman Electrician',
    background: {
      currentRoles: ['Electrician'], yearsExperience: 8, seniority: 'mid',
      skills: ['NEC Code', 'Conduit Bending', 'Blueprint Reading', 'Troubleshooting', 'Commercial Wiring', 'OSHA 30'],
      industries: ['Construction'], certifications: ['Journeyman Electrician License'],
    },
    searchIntent: intent({ targetRoles: ['Journeyman Electrician', 'Commercial Electrician'], seniority: 'mid' }),
    fits: ['electrician'], notFits: ['construction-pm', 'software-engineer'],
  },
  // Life sciences: the trap is the same INDUSTRY in a different function.
  {
    id: 'pv', label: 'Pharmacovigilance Scientist',
    background: {
      currentRoles: ['Pharmacovigilance Scientist'], earlierRoles: ['Drug Safety Associate'], yearsExperience: 6, seniority: 'senior',
      skills: ['Pharmacovigilance', 'Signal Detection', 'Argus Safety', 'MedDRA Coding', 'ICSR Processing', 'Aggregate Reports', 'GVP', 'ICH E2E'],
      industries: ['Pharmaceuticals'], certifications: [],
      education: [{ degree: 'PharmD', field: 'Pharmacy' }],
    },
    searchIntent: intent({ targetRoles: ['Pharmacovigilance Scientist', 'Drug Safety Scientist'], seniority: 'senior' }),
    fits: ['pv-scientist'], notFits: ['pharma-sales-rep', 'data-engineer', 'accountant-senior'],
  },
  // Cybersecurity: the trap is the same WORD in a different occupation.
  {
    id: 'cyber', label: 'Cybersecurity Analyst',
    background: {
      currentRoles: ['Cybersecurity Analyst'], earlierRoles: ['SOC Analyst'], yearsExperience: 4, seniority: 'mid',
      skills: ['SIEM', 'Splunk', 'Incident Response', 'Threat Hunting', 'Vulnerability Management', 'CrowdStrike', 'Wireshark', 'NIST'],
      industries: ['Technology'], certifications: ['Security+', 'CySA+'],
    },
    searchIntent: intent({ targetRoles: ['Cybersecurity Analyst', 'Security Operations Analyst'], seniority: 'mid' }),
    fits: ['cyber-analyst'], notFits: ['security-guard', 'it-helpdesk', 'nurse-recruiter'],
  },
  // Full stack Java: the trap is adjacent IT work that shares no engineering.
  {
    id: 'javafs', label: 'Full Stack Java Developer',
    background: {
      currentRoles: ['Full Stack Developer'], earlierRoles: ['Java Developer'], yearsExperience: 6, seniority: 'senior',
      skills: ['Java', 'Spring Boot', 'Microservices', 'React', 'TypeScript', 'Hibernate', 'PostgreSQL', 'REST APIs'],
      industries: ['Technology'],
    },
    searchIntent: intent({ targetRoles: ['Full Stack Java Developer', 'Senior Java Developer'], seniority: 'senior' }),
    fits: ['java-fullstack'], notFits: ['it-helpdesk', 'data-entry', 'marketing-coordinator'],
  },
];

/** Fictional contact details: activation requires a name and email. */
export const PERSONAS = RAW_PERSONAS.map((p) => ({
  identity: { fullName: `Test ${p.label}` },
  contact: { email: `${p.id}@example.com`, phone: '555-0100' },
  location: { city: 'Chicago', state: 'IL', country: 'United States', timezone: 'America/Chicago' },
  ...p,
}));

const post = (id, title, company, jdText, extra = {}) => ({
  id, title, company, jdText, location: 'Chicago, IL', source: 'greenhouse', url: `https://example.com/${id}`,
  employmentType: 'Full-time', postedAt: FRESH(), rawMetadata: {}, ...extra,
});

/** Postings, each about one occupation, written the way real ones read. */
export const POSTINGS = [
  post('rn-icu', 'Registered Nurse - ICU', 'Mercy Health',
    'Provide critical care to ICU patients. Requirements: active RN license, BSN preferred, ACLS and BLS certification, '
    + '2+ years critical care experience. Epic EHR documentation, patient assessment, ventilator management, IV therapy, triage. CCRN a plus.'),
  post('nurse-recruiter', 'Nurse Recruiter', 'Staffing Partners',
    'Recruit registered nurses for hospital clients. Full-cycle recruiting, sourcing candidates, applicant tracking systems, '
    + 'negotiating offers, building talent pipelines. Healthcare staffing experience preferred.'),
  post('accountant-senior', 'Senior Accountant', 'Northwind Financial',
    'Own month-end close, account reconciliation, accruals and financial reporting under GAAP. Support the annual audit. '
    + 'CPA preferred. NetSuite and advanced Excel required. 5+ years of accounting experience.'),
  post('ap-clerk-entry', 'Accounts Payable Clerk', 'Contoso Supply',
    'Entry-level role processing vendor invoices, data entry into the AP system, matching purchase orders. High school diploma required.'),
  post('data-entry', 'Data Entry Clerk', 'Records Co',
    'Enter records into the database accurately, verify data, file documents. Typing 50 WPM. No experience required.'),
  post('construction-pm', 'Construction Project Manager', 'BuildRight',
    'Manage commercial construction projects from preconstruction to closeout. Project scheduling with MS Project and Procore, '
    + 'budget management, subcontractor contract negotiation, OSHA compliance, risk management, stakeholder management. PMP preferred. 8+ years.'),
  post('electrician', 'Journeyman Electrician', 'Volt Electric',
    'Install commercial wiring and conduit per NEC code. Blueprint reading, troubleshooting, conduit bending. '
    + 'Journeyman Electrician license required. OSHA 30 a plus.'),
  post('software-engineer', 'Senior Backend Engineer', 'Fabrikam Cloud',
    'Design distributed systems in Go and Python. PostgreSQL, Kubernetes, gRPC and REST APIs on AWS. 5+ years building backend services.',
    { location: 'Remote, US' }),
  post('vp-operations', 'Vice President of Operations', 'Litware Manufacturing',
    'Executive leadership of plant operations with full P&L management. Drive operational excellence and Lean Six Sigma, '
    + 'supply chain strategy, budgeting and M&A integration. 15+ years with 5+ in senior leadership.'),
  post('executive-assistant', 'Executive Assistant to the CEO', 'Litware Manufacturing',
    'Manage the CEO calendar, travel, expense reports and board meeting logistics. Microsoft Office, discretion, scheduling.'),
  post('marketing-coordinator', 'Marketing Coordinator', 'Blue Yonder Retail',
    'Entry-level role supporting campaigns: social media marketing, email marketing, content writing, SEO, Google Analytics reporting, Canva. '
    + '0-2 years experience; recent graduates welcome.'),
  post('instructional-designer', 'Instructional Designer', 'Woodgrove Learning',
    'Design eLearning with Articulate Storyline using ADDIE. Curriculum development, assessment design, adult learning principles, '
    + 'LMS administration. Teaching background welcome.', { location: 'Remote, US' }),
  post('pv-scientist', 'Pharmacovigilance Scientist', 'Contoso Pharma',
    'Lead signal detection and safety evaluation for marketed products. Review ICSRs, MedDRA coding, aggregate reports (PSUR, DSUR) '
    + 'under GVP and ICH E2E. Argus Safety experience required. PharmD, PhD or RN with 5+ years in drug safety.'),
  post('pharma-sales-rep', 'Pharmaceutical Sales Representative', 'Contoso Pharma',
    'Promote our cardiovascular portfolio to physicians in your territory. Meet sales quotas, build HCP relationships, '
    + 'run lunch-and-learns, manage CRM records. 2+ years of B2B sales; pharmaceutical industry knowledge a plus.'),
  post('cyber-analyst', 'Cybersecurity Analyst', 'Woodgrove Bank',
    'Monitor and triage alerts in our SIEM (Splunk), lead incident response, threat hunting and vulnerability management. '
    + 'CrowdStrike EDR, Wireshark, NIST CSF. Security+ or CySA+ required. 3+ years in a SOC.'),
  post('security-guard', 'Security Officer', 'Fabrikam Facilities',
    'Patrol the building, monitor CCTV, control visitor access and write incident reports. Guard card required. Night shifts.'),
  post('it-helpdesk', 'IT Help Desk Technician', 'Litware Manufacturing',
    'Answer support tickets, reset passwords, image laptops and set up printers. CompTIA A+ preferred. Entry level.'),
  post('java-fullstack', 'Senior Full Stack Java Developer', 'Northwind Systems',
    'Build microservices in Java with Spring Boot and Hibernate, and React/TypeScript front ends. PostgreSQL, REST APIs, CI/CD. '
    + '5+ years of full stack development.', { location: 'Remote, US' }),
  post('data-engineer', 'Senior Data Engineer', 'Adatum Analytics',
    'Build ETL pipelines with Databricks, PySpark, Snowflake and dbt. SQL, Python, Airflow, data modeling. 5+ years.',
    { location: 'Remote, US' }),
];
