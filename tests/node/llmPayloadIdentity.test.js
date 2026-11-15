/**
 * Your name and contact details never reach a model provider (audit N1).
 *
 * Grounded cover letters sent every resume unit of kind `bullet` or
 * `paragraph`, and the resume's name line and contact line ARE paragraphs, so
 * "Jordan Example" and "Springfield, IL | 555-010-0000 | jordan@example.com"
 * went to the provider with the rest. `.env.example` said contact details are
 * never sent by any model feature. Only those lines are dropped: the summary
 * and every bullet still go, because the letter cites them.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { composeGroundedLetter } from '../../src/apply/groundedLetter.js';
import { draftReply } from '../../src/inbox/draftReply.js';
import { SUGGESTION_EVENT } from '../../src/inbox/sync.js';
import { withoutIdentityUnits } from '../../src/llm/identityUnits.js';
import { openDatabase } from '../../src/logging/db.js';
import { proposeRewrites } from '../../src/resume/rewrites.js';
import { rerank } from '../../src/scoring/semanticRerank.js';

const CANDIDATE = {
  identity: { fullName: 'Jordan Example', links: { linkedin: 'https://www.linkedin.com/in/jordan-example/' } },
  contact: { email: 'jordan@example.com', phone: '5550100000' },
  location: { city: 'Springfield', state: 'IL' },
};
const ROLE = 'Senior Data Engineer | Example Corp | Jan 2019 - Present';
// The shape tailor.py master_units returns for a typical resume.
const UNITS = [
  { id: 'u0', kind: 'paragraph', role: null, text: 'Jordan Example' },
  { id: 'u1', kind: 'paragraph', role: null, text: 'Springfield, IL | 555-010-0000 | jordan@example.com' },
  { id: 'u2', kind: 'paragraph', role: null, text: 'linkedin.com/in/jordan-example' },
  { id: 'u3', kind: 'paragraph', role: null, text: 'Senior Data Engineer' },
  { id: 'u4', kind: 'section', role: null, text: 'PROFESSIONAL SUMMARY' },
  { id: 'u5', kind: 'paragraph', role: null, text: 'Data engineer with ten years building reporting platforms for finance teams.' },
  { id: 'u6', kind: 'section', role: null, text: 'PROFESSIONAL EXPERIENCE' },
  { id: 'u7', kind: 'role', role: ROLE, text: ROLE },
  { id: 'u8', kind: 'bullet', role: ROLE, text: 'Built data pipelines for finance reporting, cutting refresh time by 40% between 2019 - 2021.' },
  { id: 'u9', kind: 'bullet', role: ROLE, text: 'Published the pipeline design at example.com/post for 1,200 readers.' },
];
const ids = (units) => units.map((u) => u.id);

describe('withoutIdentityUnits', () => {
  it('drops the name line and contact lines above the first section, and keeps everything else', () => {
    expect(ids(withoutIdentityUnits(UNITS, CANDIDATE))).toEqual(['u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9']);
  });

  it('works from the shape of the lines alone when the profile is empty', () => {
    expect(ids(withoutIdentityUnits(UNITS, {}))).toEqual(['u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9']);
  });

  it('drops a line anywhere that carries an email address or a phone number', () => {
    const units = [...UNITS,
      { id: 'u10', kind: 'paragraph', role: null, text: 'References: Pat Doe, pat@example.org, (555) 010-0199' },
      { id: 'u11', kind: 'bullet', role: ROLE, text: 'Answered on-call pages at +1 555 010 0000 during the 2020 - 2021 migration.' }];
    expect(ids(withoutIdentityUnits(units, {}))).not.toContain('u10');
    expect(ids(withoutIdentityUnits(units, {}))).not.toContain('u11');
  });

  it('drops a line naming the person or their own profile links, wherever it sits', () => {
    const units = [...UNITS,
      { id: 'u10', kind: 'paragraph', role: null, text: 'Jordan Example' },
      { id: 'u11', kind: 'paragraph', role: null, text: 'Portfolio: https://www.linkedin.com/in/jordan-example/' }];
    expect(ids(withoutIdentityUnits(units, CANDIDATE))).not.toContain('u10');
    expect(ids(withoutIdentityUnits(units, CANDIDATE))).not.toContain('u11');
  });

  it('handles a resume with no section headings: the first line is still the name', () => {
    const flat = UNITS.filter((u) => u.kind !== 'section');
    expect(ids(withoutIdentityUnits(flat, {}))).toEqual(['u3', 'u5', 'u7', 'u8', 'u9']);
  });

  it('never drops dates, percentages or counts that only look numeric', () => {
    const kept = withoutIdentityUnits(UNITS, {}).map((u) => u.text).join('\n');
    expect(kept).toMatch(/2019 - 2021/);
    expect(kept).toMatch(/1,200 readers/);
  });
});

describe('a grounded cover letter request', () => {
  it('sends the summary and bullets but not the name or contact details', async () => {
    const requests = [];
    const paragraphs = [
      { text: 'At Example Corp I built data pipelines for finance reporting, cutting refresh time by 40%.', evidence: ['u8'] },
      { text: 'I am a data engineer with ten years building reporting platforms for finance teams.', evidence: ['u5'] },
    ];
    const r = await composeGroundedLetter({
      job: { id: 'j1', company: 'Globex', title: 'Data Engineer' },
      config: { root: null, candidate: CANDIDATE, scoring: {} },
      env: { LLM_ASSIST: 'on', NVIDIA_API_KEY: 'k', COVER_LETTER_MODE: 'grounded' },
      deps: {
        readMasterUnitsFn: async () => UNITS,
        masterLetterText: 'Dear Hiring Manager,\n\nI enjoy turning messy sources into reliable reporting.\n\nReach me at jordan@example.com or 555-010-0000.\n\nSincerely,\nJordan Example',
        fetchImpl: async (url, init) => {
          requests.push(String(init?.body ?? ''));
          return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ paragraphs }) } }] }) };
        },
      },
    });
    expect(r.ok).toBe(true);
    const sent = requests.join('\n');
    expect(sent).toMatch(/ten years building reporting platforms/);
    expect(sent).toMatch(/Built data pipelines for finance reporting/);
    expect(sent).toMatch(/messy sources into reliable reporting/);
    for (const secret of ['Jordan Example', 'jordan@example.com', '555-010-0000', 'Springfield', 'linkedin.com/in/jordan-example']) {
      expect(sent).not.toContain(secret);
    }
  });
});

/** A model double that records every request body it receives. */
function recordingModel(reply) {
  const bodies = [];
  return {
    bodies,
    fetchImpl: async (url, init) => {
      bodies.push(String(init?.body ?? ''));
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) };
    },
  };
}
const CONTACT_BULLET = { id: 'u10', kind: 'bullet', role: ROLE, text: 'Ran the on-call line at 555-010-0000 for the finance platform.' };

describe('other model features that send resume bullets', () => {
  it('rewrite suggestions never send a bullet carrying a phone number', async () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'j1', company: 'Globex', title: 'Data Engineer', url: 'https://x/1', jd_text: 'Finance reporting.' });
    const model = recordingModel({ rewrites: [] });
    await proposeRewrites({
      db, job: db.getJob('j1'), config: { root: null, scoring: {}, candidate: CANDIDATE },
      env: { LLM_ASSIST: 'on', NVIDIA_API_KEY: 'k', RESUME_REWRITE: 'suggest' },
      deps: { fetchImpl: model.fetchImpl, readMasterUnitsFn: async () => [...UNITS, CONTACT_BULLET], extractJdRequirementsFn: async () => ({ phrases: ['reporting'] }) },
    });
    const sent = model.bodies.join('\n');
    expect(sent).toMatch(/Built data pipelines for finance reporting/);
    expect(sent).not.toContain('555-010-0000');
    db.close();
  });

  it('reply drafts never send a bullet carrying a phone number', async () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'g1', company: 'Globex', title: 'Data Engineer', url: 'https://x/1', applied: 1, status: 'submitted' });
    const id = randomUUID();
    db.insertEvent({ id, job_id: 'g1', event_type: SUGGESTION_EVENT, message: 'interview', metadata: JSON.stringify({
      messageId: '<m@x>', kind: 'interview', outcome: 'interviewing', subject: 'Phone screen', evidence: 'Could you share your availability?',
      from: { name: 'Pat Recruiter', domain: 'globex.com', address: 'pat@globex.com' },
    }) });
    const model = recordingModel({ paragraphs: [{ text: 'Thank you for reaching out.', evidence: [] }] });
    await draftReply({
      db, suggestionId: id, config: { candidate: CANDIDATE }, env: { LLM_ASSIST: 'on', NVIDIA_API_KEY: 'k' },
      deps: { fetchImpl: model.fetchImpl, readMasterUnitsFn: async () => [...UNITS, CONTACT_BULLET] },
    }).catch(() => null);
    const sent = model.bodies.join('\n');
    expect(sent).toMatch(/Built data pipelines for finance reporting/);
    expect(sent).not.toContain('555-010-0000');
    db.close();
  });
});

describe('rank by meaning', () => {
  it('never sends a bullet carrying a phone number to the embeddings model', async () => {
    const db = openDatabase({ path: ':memory:' });
    const now = new Date().toISOString();
    db.upsertJob({ id: 'sp', company: 'Initech', title: 'Data Engineer', url: 'https://x/2', source: 'lever', score: 80, tier: 'Apply', status: 'scored', posted_at: now, created_at: now, jd_text: 'Finance reporting pipelines.' });
    const bodies = [];
    const fetchImpl = async (_url, init) => {
      bodies.push(String(init?.body ?? ''));
      const { input } = JSON.parse(init.body);
      return { ok: true, json: async () => ({ data: input.map(() => ({ embedding: [1, 0.5, 0.2] })) }) };
    };
    await rerank({ db, config: { candidate: CANDIDATE }, env: { RERANK: 'on', RERANK_MODEL: 'test-embed', NVIDIA_API_KEY: 'k' },
      deps: { fetchImpl, readMasterUnitsFn: async () => [...UNITS, CONTACT_BULLET] } });
    const sent = bodies.join('\n');
    expect(sent).toMatch(/Built data pipelines for finance reporting/);
    expect(sent).not.toContain('555-010-0000');
    db.close();
  });
});
