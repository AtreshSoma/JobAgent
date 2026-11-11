// @ts-check
/**
 * Small, dependency-light startup gate shared by the regular CLI and the
 * one-command dashboard launcher. Keeping it outside index.js avoids a
 * bidirectional app.js <-> index.js import.
 */

import { existsSync } from 'node:fs';

import { requiredProfileGaps } from './doctor.js';
import { findPlaceholders } from '../config/placeholders.js';
import { resumeProfileMismatch } from '../profile/resumeIdentity.js';
import { masterResumeFile } from '../profile/workspace.js';

/**
 * Re-exported so existing callers and tests keep importing it from here. The
 * implementation moved to src/profile/resumeIdentity.js so that
 * `preparePacket` — the chokepoint every preparation path goes through — can
 * run the same check without pulling a CLI module into the core pipeline.
 */
export { resumeProfileMismatch };

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
  const master = masterResumeFile(config.root);
  if (!existsSync(master)) {
    problems.push('Master resume not found at resumes/base/MASTER_RESUME.docx — it is the read-only source for tailoring.');
  } else {
    problems.push(...resumeProfileMismatch(config, master));
  }
  return { ok: problems.length === 0, problems };
}
