/**
 * How to fix each System health finding, from the dashboard (S1: no command
 * lines anywhere in the UI).
 *
 * `npm run doctor` writes its fixes for the terminal it runs in: `npm ci`,
 * `pip install …`, `npm run profiles activate …`. The dashboard showed those
 * same lines to someone who opened it from a launcher and has no terminal.
 * Here each check gets the screen or button that fixes it. Where no screen
 * exists yet (setting up Python), it says so in words. The terminal output is
 * unchanged.
 */
import { BROWSER_INSTALL_FIX } from './data.js';

const RELAUNCH = 'Close JobAgent and open it again from its launcher, which installs what is missing.';
const PYTHON = 'Resume tailoring needs Python 3.12 or newer. Install it from python.org, then close JobAgent and open it again from its launcher, '
  + 'which offers to set up the rest. Until then, jobs use your master resume as it is.';

/** Check id -> what to do in the dashboard. */
const FIXES = {
  'profile-active': 'Open Master resume and choose Save my current setup as a profile under Search profiles.',
  'profile-sync': 'Open Master resume and switch to your profile again under Search profiles, so your settings match it.',
  'profile-targets': 'Open Master resume, choose Edit on your search profile, and add at least one target role.',
  'profile-skills': 'Open Master resume and add skills from Suggestions from your resume, or choose Edit on your search profile.',
  node: RELAUNCH,
  dependencies: RELAUNCH,
  sqlite: RELAUNCH,
  browser: BROWSER_INSTALL_FIX,
  python: PYTHON,
  'python-docx': PYTHON,
  'pdf-converter': 'Optional: with Microsoft Word or LibreOffice installed, PDFs are made from the Word file. Without either, JobAgent prints them itself.',
  pytest: 'Only needed to run JobAgent\'s own tests. Nothing to do.',
  profile: 'Open the account menu, choose Application profile, and fill in the missing fields.',
  'profile-optional': 'Open the account menu, choose Application profile, and fill in what applies to you.',
  'profile-placeholders': 'Use the setup card at the top of the page.',
  'cover-letter': 'Close JobAgent and open it again from its launcher. It creates the cover-letter settings from the example; then replace the example values under Application profile.',
  resume: 'Open the account menu, choose Master resume, and upload your resume.',
  config: 'A settings file could not be read. The detail names it; the User Guide\'s troubleshooting section explains how to repair it.',
  db: 'The job database could not be opened. Close JobAgent, open it again from its launcher, and check the detail if it happens again.',
  vocabulary: 'Open a job, find Also asked for, and choose Look for this skill on the real skills its postings name. Jobs are scored again afterwards.',
  outputs: 'JobAgent cannot write to the folders named in the detail. Check their permissions in Finder or File Explorer.',
};

/** A command line, a file path or a package-manager word: never shown in the dashboard. */
export const COMMAND_LINE = /`|\bnpm\b|\bnpx\b|\bpip3?\b|\bpython3?\s+-|\.venv|\bnode\s+(src|scripts)\/|config\/[\w./-]+\.json/;

/**
 * The fix to show in the dashboard for one doctor check, or null when it has none.
 * A check this map does not know yet keeps its own fix only if it holds no command.
 *
 * @param {{id?: string, status?: string, fix?: string}} check
 * @returns {string|null}
 */
export function dashboardFix(check = {}) {
  if (!check.fix && check.status === 'pass') return null;
  if (FIXES[check.id]) return check.fix || check.status !== 'pass' ? FIXES[check.id] : null;
  if (!check.fix) return null;
  return COMMAND_LINE.test(check.fix) ? 'See the User Guide\'s troubleshooting section for this check.' : check.fix;
}

/**
 * A doctor report with every fix rewritten for the dashboard.
 *
 * @param {{checks?: object[]}} report
 * @returns {object}
 */
export function forDashboard(report = {}) {
  return {
    ...report,
    checks: (report.checks ?? []).map((check) => {
      const fix = dashboardFix(check);
      const { fix: _terminal, ...rest } = check;
      return fix ? { ...rest, fix } : rest;
    }),
  };
}
