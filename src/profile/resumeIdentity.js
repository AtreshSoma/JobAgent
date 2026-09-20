/**
 * "Is the master resume the active profile's person?"
 *
 * WHY THIS IS ITS OWN MODULE. The check began life inside `src/cli/preflight.js`
 * and so ran only on the paths that call preflight — the CLI and the dashboard's
 * startup gate. `preparePacket` is the chokepoint every preparation path goes
 * through, including "Prepare selected" and auto-apply, and it did NOT run this
 * check. Measured: preflight reported an identity mismatch and packet
 * preparation for the same workspace still succeeded, producing a tailored
 * resume and cover letter that put one person's name and target role on another
 * person's career history.
 *
 * Living in `src/profile/` lets the core pipeline import it without depending on
 * a CLI module (`preflight.js` imports `doctor.js`, which has no business being
 * pulled into packet preparation). `preflight.js` re-exports it so its own
 * callers and tests are unchanged.
 */

import { existsSync, readFileSync } from 'node:fs';

import { extractDocxText } from '../resume/docxText.js';
import { buildBackground, compareToActiveProfile } from './fromResume.js';
import { loadRoleFamilies } from './roleFamilies.js';

/**
 * Compare the master resume against the active profile.
 *
 * Returns `null` when there is nothing to compare (no active profile, or a
 * resume that cannot be read) — an unreadable resume is reported by its own
 * check and must never become a false accusation about whose resume it is.
 *
 * @param {object} config loadConfig() bundle
 * @param {string} master absolute path to the master resume
 * @returns {{relation: string, confidence: string, reasons: string[], summary: string}|null}
 */
export function compareMasterResume(config, master) {
  const profile = config?.profile;
  if (!profile) return null;
  if (!master || !existsSync(master)) return null;
  try {
    const { paragraphs } = extractDocxText(readFileSync(master));
    const background = buildBackground(paragraphs, { sourceFile: master });
    return compareToActiveProfile(background, profile, loadRoleFamilies(config.root));
  } catch {
    return null;
  }
}

/**
 * Is this a mismatch that must BLOCK, as opposed to one worth mentioning?
 *
 * Only an unmistakable one. `compareToActiveProfile` reports `different` both
 * when the resume names somebody else outright AND when it names the SAME
 * person working in an unrelated field — which is a career change, the case a
 * user deliberately creates when they build a search for the profession they
 * are moving into. It marks that second case with `confidence: 'low'` and says
 * so in its reasons, and blocking it told exactly those users their own resume
 * belonged to someone else.
 *
 * So the block is: relation `different` AND the comparison is not the
 * low-confidence career-change reading.
 *
 * @param {{relation?: string, confidence?: string}|null} comparison
 * @returns {boolean}
 */
export function isBlockingResumeMismatch(comparison) {
  if (!comparison) return false;
  if (comparison.relation !== 'different') return false;
  return comparison.confidence !== 'low';
}

/**
 * Human-readable problems when the master resume does not belong to the active
 * profile's candidate.
 *
 * It refuses rather than improvises. A run that stops with a clear reason costs
 * a minute; a plausible document describing the wrong person's career does not
 * announce itself at all.
 *
 * @param {object} config loadConfig() bundle
 * @param {string} master absolute path to the master resume
 * @returns {string[]} problems (empty when the resume is usable)
 */
export function resumeProfileMismatch(config, master) {
  const comparison = compareMasterResume(config, master);
  if (!isBlockingResumeMismatch(comparison)) return [];
  const profile = config.profile;
  return [
    `The master resume does not match the active search profile "${profile.label}". `
    + `${comparison.summary} `
    + `(${comparison.reasons[0] ?? 'no shared role family'}). `
    + 'Tailoring would put this profile\'s name and target role on that resume\'s career history. '
    + 'Upload the right resume, or run `npm run profiles from-resume` to build a profile that matches it.',
  ];
}
