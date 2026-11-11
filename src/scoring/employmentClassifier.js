/**
 * Employment-type classifier.
 *
 * Deterministic, config-driven categorization of a job into one of:
 *   - 'contract'          (W2 contract, C2C, 1099, temporary, 6/12-month, staffing)
 *   - 'contract_to_hire'  (contract-to-hire / temp-to-perm)
 *   - 'part_time'         (explicitly part-time)
 *   - 'full_time'         (permanent / direct-hire — also the safe default)
 *   - 'unknown'           (only when defaultToFullTime is disabled and no signal)
 *
 * Why a default of full_time: the overwhelming majority of postings on the
 * direct-employer boards this agent searches (Greenhouse/Lever/Ashby/Workday)
 * are permanent full-time roles that never populate an explicit employment-type
 * field. Contract/temp/part-time postings, by contrast, almost always announce
 * themselves with a specific phrase. So the discriminating signal is the
 * PRESENCE of a contract/part-time marker; absence implies full-time. This keeps
 * the Full-time vs Contract split useful and mostly-correct. Disable the default
 * (markers.defaultToFullTime = false) to get honest 'unknown' instead.
 *
 * All phrases come from config (config/exclusions.json -> employmentTypes);
 * nothing is hardcoded here.
 */

import { normalizeText, matchedPhrases } from '../utils/textNormalize.js';

/** Human labels for each category (used by the dashboard). */
export const EMPLOYMENT_LABELS = Object.freeze({
  full_time: 'Full-time',
  contract: 'Contract',
  contract_to_hire: 'Contract-to-hire',
  part_time: 'Part-time',
  unknown: 'Unknown',
});

/**
 * Classify a normalized job's employment type.
 *
 * The employment-type field and the title are the most reliable signals, so
 * they are inspected first ("primary"). The JD body ("secondary") is only
 * consulted for the specific, multi-word contract/temp phrases in config, which
 * avoids false positives from incidental words like "data contract".
 *
 * @param {object} job normalized job ({ employmentType, title, jdText })
 * @param {object} [markers] config/exclusions.json employmentTypes block
 * @param {string[]} [markers.contract]
 * @param {string[]} [markers.contractToHire]
 * @param {string[]} [markers.partTime]
 * @param {string[]} [markers.fullTime]
 * @param {boolean} [markers.defaultToFullTime=true]
 * @returns {{ category: string, matched: string[] }}
 */
export function classifyEmployment(job = {}, markers = {}) {
  const contract = markers.contract ?? [];
  const contractToHire = markers.contractToHire ?? [];
  const partTime = markers.partTime ?? [];
  const fullTime = markers.fullTime ?? [];
  const defaultToFullTime = markers.defaultToFullTime !== false;

  // schema.org and ATS feeds spell the field as enum values (PART_TIME,
  // FULL_TIME); `_` -> space lets the configured "part time" phrase see them.
  const field = normalizeText(String(job.employmentType ?? '').replace(/_/g, ' '));
  const primary = normalizeText([field, job.title].join(' \n '));
  const secondary = normalizeText(job.jdText);
  const inAny = (list) => [
    ...matchedPhrases(primary, list),
    ...matchedPhrases(secondary, list),
  ];

  // Precedence: contract-to-hire is more specific than contract, so it wins.
  // Contract/C2H phrases are specific multi-word markers, so scanning the JD
  // body ("secondary") is safe. Part-time and full-time are single, common
  // words that appear constantly in JD boilerplate ("full-time or part-time",
  // benefits/EEO text), so they are asserted ONLY from the reliable primary
  // text (employment-type field + title) to avoid false positives.
  const c2h = inAny(contractToHire);
  if (c2h.length) return { category: 'contract_to_hire', matched: dedupe(c2h) };

  const c = inAny(contract);
  if (c.length) return { category: 'contract', matched: dedupe(c) };

  // The structured field is a controlled vocabulary (schema.org CONTRACTOR /
  // TEMPORARY, Ashby/Adzuna "Contract"), so a single word there is a reliable
  // marker — unlike the same word in prose, which is why the config list is
  // multi-word only. Read from the FIELD alone, never the title or body.
  const fieldContract = field.match(STRUCTURED_CONTRACT_RE);
  if (fieldContract) return { category: 'contract', matched: [fieldContract[0]] };

  // Full-time is checked BEFORE part-time and only from the reliable primary
  // text. This means a flexible "Full Time/Part Time" role is reported as
  // full_time (full-time IS available — the useful signal for a full-time
  // seeker), while a role whose only signal is "Part Time" falls through to
  // part_time below.
  const ft = matchedPhrases(primary, fullTime);
  if (ft.length) return { category: 'full_time', matched: dedupe(ft) };

  const pt = matchedPhrases(primary, partTime);
  if (pt.length) return { category: 'part_time', matched: dedupe(pt) };

  if (defaultToFullTime) return { category: 'full_time', matched: [] };
  return { category: 'unknown', matched: [] };
}

/** Contract-family enum values as they appear in a structured employmentType. */
const STRUCTURED_CONTRACT_RE = /\b(?:contract|contractor|temporary|temp|freelance|per diem|seasonal)\b/;

function dedupe(list) {
  return [...new Set(list)];
}
