/**
 * Small, dependency-light startup gate shared by the regular CLI and the
 * one-command dashboard launcher. Keeping it outside index.js avoids a
 * bidirectional app.js <-> index.js import.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { requiredProfileGaps } from './doctor.js';
import { findPlaceholders } from '../config/placeholders.js';

/**
 * Minimal hard-requirement gate: required candidate fields and the master
 * resume. The dashboard may still start with these gaps, but preparation must
 * remain disabled until the user supplies truthful data.
 *
 * @param {object} config loadConfig() bundle
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function quickPreflight(config) {
  const problems = [];
  for (const gap of requiredProfileGaps(config.candidate)) {
    problems.push(`Candidate profile is missing ${gap.label} — add "${gap.path}" to config/candidate.json (true information only).`);
  }
  // A field can be PRESENT and still be the shipped template text. Copying the
  // .example files is the documented first step, and every gate used to pass
  // them: doctor reported "ready to run" for a profile whose work-authorization
  // status literally read "US Citizen | Green Card | H-1B | OPT | ...". Presence
  // is not plausibility — see src/config/placeholders.js.
  problems.push(...findPlaceholders(config).problems);
  const master = join(config.root, 'resumes', 'base', 'MASTER_RESUME.docx');
  if (!existsSync(master)) {
    problems.push('Master resume not found at resumes/base/MASTER_RESUME.docx — it is the read-only source for tailoring.');
  }
  return { ok: problems.length === 0, problems };
}
