/**
 * Free-text answers the person approved, for ONE job each (audit A4).
 *
 * A draft answer is shown, edited and approved per answer. Once approved it is
 * kept here under the job it was approved for and used on that job's form only,
 * never on another employer's: "Why do you want to work here?" has a different
 * true answer at every company. These are not saved screening answers, so they
 * can never match a question on another job.
 *
 * The question must be an open one: a sensitive, eligibility, pay or skill-years
 * question is refused, because those belong in the screening answers where they
 * are checked. The text is the person's own, as edited: it is stored verbatim.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../utils/fsSafe.js';
import { workspacePaths } from '../profile/workspace.js';
import { normalizeText } from '../utils/textNormalize.js';
import { draftRefusal } from './draftGuard.js';
import { questionKey } from './questionQueue.js';

const FILE = 'approved_answers.json';
const MAX_TEXT = 4000;
const MAX_PER_JOB = 40;

const fileOf = (root) => join(workspacePaths(root).dataDir, FILE);

function load(root) {
  try {
    const parsed = JSON.parse(readFileSync(fileOf(root), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.jobs && typeof parsed.jobs === 'object' ? parsed : { version: 1, jobs: {} };
  } catch {
    return { version: 1, jobs: {} };
  }
}

function save(root, data) {
  if (!existsSync(workspacePaths(root).dataDir)) throw new Error('the data folder does not exist');
  writeFileAtomic(fileOf(root), `${JSON.stringify(data, null, 2)}\n`);
}

/** The approved answers for one job. */
export function readApprovedAnswers(root, jobId) {
  if (!root || !jobId) return [];
  return load(root).jobs[String(jobId)] ?? [];
}

/**
 * Keep an answer the person approved for this job.
 * @param {string} root
 * @param {string} jobId
 * @param {{question: string, text: string, evidence?: string[], source?: 'draft'|'written'}} entry
 */
export function approveAnswer(root, jobId, { question, text, evidence = [], source = 'written' } = {}) {
  if (!root || !jobId) throw new Error('which job? send its id');
  const q = String(question ?? '').replace(/\s+/g, ' ').trim();
  const a = String(text ?? '').trim();
  if (!q) throw new Error('which question? send it');
  if (!a) throw new Error('the answer is empty');
  if (a.length > MAX_TEXT) throw new Error(`the answer is too long (${a.length} characters, limit ${MAX_TEXT})`);
  if (draftRefusal(q)) {
    throw new Error('that question asks for a fact about you (eligibility, pay, history, health or skill years); '
      + 'answer it in your screening answers, where it is checked');
  }
  const data = load(root);
  const key = questionKey(q);
  const list = (data.jobs[String(jobId)] ?? []).filter((e) => e.key !== key);
  list.unshift({
    key, question: q, text: a, source: source === 'draft' ? 'draft' : 'written',
    evidence: (Array.isArray(evidence) ? evidence : []).map(String).slice(0, 10), approvedAt: new Date().toISOString(),
  });
  data.jobs[String(jobId)] = list.slice(0, MAX_PER_JOB);
  save(root, data);
  return data.jobs[String(jobId)][0];
}

/** Take an approved answer back. */
export function removeApprovedAnswer(root, jobId, question) {
  const data = load(root);
  const key = questionKey(question);
  const before = data.jobs[String(jobId)] ?? [];
  const after = before.filter((e) => e.key !== key);
  if (after.length === before.length) return false;
  if (after.length) data.jobs[String(jobId)] = after; else delete data.jobs[String(jobId)];
  save(root, data);
  return true;
}

/**
 * Screening answers with this job's approved answers added in front, each
 * matching its own question exactly and nothing else.
 */
export function withApprovedAnswers(screeningAnswers = {}, approved = []) {
  if (!approved.length) return screeningAnswers;
  const entries = approved.map((e, i) => ({
    id: `approved_${i + 1}_${e.key.replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`,
    patterns: [normalizeText(e.question).replace(/[^a-z0-9]+$/g, '').trim()],
    answer: e.text,
    type: 'text',
  }));
  return { ...screeningAnswers, answers: [...entries, ...(screeningAnswers.answers ?? [])] };
}
