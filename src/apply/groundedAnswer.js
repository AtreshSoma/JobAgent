/**
 * Grounded draft answers to free-text questions (audit A4).
 *
 * "Why do you want to work here?" has no saved answer by design. With the
 * optional model on, this drafts one from the master resume, citing the lines
 * it used, then runs it through the same claim verifier a cover letter does:
 * numbers, named things and ownership must come from the cited resume text or
 * the profile, never from the posting; only the company and role title may
 * come from the posting. A draft that fails is not offered.
 *
 * A draft is only ever SHOWN. The person edits and approves it, per answer and
 * for that one job (approvedAnswers.js); it is never reused for another
 * employer and nothing here submits anything. The model never receives the
 * person's name or contact lines.
 */
import { llmSettings } from '../llm/client.js';
import { withoutContactLines, withoutIdentityUnits } from '../llm/identityUnits.js';
import { runTask, SYSTEM_UNTRUSTED_RULE } from '../llm/task.js';
import { profileTerms, verifyParagraph } from '../resume/claimVerifier.js';
import { readMasterUnits, vocabularyFromScoring } from '../resume/tailorRunner.js';
import { draftRefusal } from './draftGuard.js';

export { draftRefusal };

const SYSTEM = [
  'You draft a short answer to ONE open question on a job application, in the first person, under 120 words.',
  '',
  'Rules:',
  '1. Cite, in "evidence", the resume units (ids like u3) whose facts the answer uses.',
  '2. Use only facts written in the cited units. Never add a number, tool, technology, employer, product,',
  '   certification, degree or achievement that is not in them.',
  '3. The company name and role title may be used. Requirement phrases from the posting are hints about what to',
  '   bring forward, not facts about the candidate: mention one only if the cited units contain it.',
  '4. Never strengthen ownership ("contributed" never becomes "led").',
  '5. Say nothing about the company that is not in the posting text given. No greeting, no sign-off, no placeholders.',
  `6. ${SYSTEM_UNTRUSTED_RULE}`,
  '',
  'Respond with JSON only: {"text":"...","evidence":["u2","u5"]}',
].join('\n');

export const FREE_TEXT_ANSWER_TASK = Object.freeze({
  name: 'free-text-answer',
  version: 1,
  system: SYSTEM,
  maxTokens: 800,
  schema: {
    type: 'object', additionalProperties: false, required: ['text', 'evidence'],
    properties: { text: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } },
  },
  buildUser: ({ company, title, question, requirements, bullets }) => [
    `COMPANY: ${company}`,
    `ROLE: ${title}`,
    `QUESTION: ${question}`,
    '',
    'REQUIREMENT PHRASES (hints only):',
    requirements.length ? requirements.map((r) => `- ${r}`).join('\n') : '- (none)',
    '',
    'RESUME UNITS:',
    ...bullets.map((u) => `${u.id}: ${u.text}${u.role ? `  [${u.role}]` : ''}`),
  ].join('\n'),
  postValidate: (data) => (String(data.text ?? '').trim() ? [] : ['the answer is empty']),
});

/**
 * @returns {Promise<{ok: boolean, text?: string, evidence?: Array<{id: string, text: string, role?: string}>,
 *   reason?: string, provenance?: object}>}
 */
export async function draftGroundedAnswer({ job, question, config, requirements = [], env = process.env, deps = {} }) {
  const refusal = draftRefusal(question);
  if (refusal) return { ok: false, reason: refusal };
  const root = config?.root ?? null;
  const settings = llmSettings(env, { root });
  if (!settings.enabled) return { ok: false, reason: `drafting needs the LLM assist: ${settings.reason}` };

  let units;
  try {
    units = await (deps.readMasterUnitsFn ?? readMasterUnits)({ root, deps });
  } catch (err) {
    return { ok: false, reason: `could not read the master resume: ${err.message}` };
  }
  // The name line and contact lines are not evidence and never go to the provider.
  const candidate = config?.candidate ?? {};
  units = withoutContactLines(withoutIdentityUnits(units, candidate), candidate);
  const bullets = units.filter((u) => u.kind === 'bullet' || u.kind === 'paragraph').slice(0, 60);
  const company = String(job?.company ?? '').trim();
  const title = String(job?.title ?? '').trim();

  const result = await runTask(FREE_TEXT_ANSWER_TASK,
    { company, title, question: String(question).trim(), requirements: requirements.slice(0, 30), bullets },
    { settings, deps });
  if (!result.ok) return { ok: false, reason: result.error };

  const unitMap = new Map(units.map((u) => [u.id, u]));
  const vocabulary = [...new Set([...vocabularyFromScoring(config?.scoring ?? {}), ...requirements])].map((t) => String(t).toLowerCase());
  const verdict = verifyParagraph({
    text: result.data.text, evidenceIds: result.data.evidence, units: unitMap,
    profile: profileTerms(candidate), vocabulary, literals: [company, title],
  });
  if (!verdict.ok) {
    return { ok: false, reason: `the draft was not backed by your resume: ${verdict.reasons.join('; ')}`, provenance: result.provenance };
  }
  return {
    ok: true,
    text: String(result.data.text).trim(),
    evidence: verdict.evidence.map((id) => ({ id, text: unitMap.get(id).text, ...(unitMap.get(id).role ? { role: unitMap.get(id).role } : {}) })),
    provenance: result.provenance,
  };
}
