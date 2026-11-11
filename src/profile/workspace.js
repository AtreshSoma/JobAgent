/**
 * Where the active person's data lives.
 *
 * Each search profile owns a WORKSPACE: its own job database, master resume
 * (with its version history), tracker spreadsheet and application output
 * folder. Before workspaces, every profile shared one of each, so switching to
 * a second person showed them the first person's jobs, shortlists and
 * applications, tailored their applications from the first person's resume,
 * and rescored thousands of the first person's jobs under the second person's
 * profile.
 *
 * THE ORIGINAL WORKSPACE IS WHERE IT ALWAYS WAS. A profile with no `workspace`
 * id — every profile saved before workspaces existed — uses the original paths
 * (data/applied_jobs.db, resumes/base/MASTER_RESUME.docx, ...). Nothing is
 * moved, copied or migrated; profiles created from now on get their own folder.
 *
 * Deliberately dependency-light (fs + path only): the database opener and the
 * CLI resolve through it, and it must not pull the profile store, the pipeline
 * or the config loader into either.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * The workspace id of the active profile, or '' for the original workspace.
 * Any problem reading it (no profiles yet, a hand-edited file) means the
 * original workspace — the one place that is always safe to fall back to.
 *
 * @param {string} root project root
 * @returns {string}
 */
export function activeWorkspaceId(root) {
  try {
    const dir = join(root, 'config', 'profiles');
    const activeFile = join(dir, '_active.json');
    if (!existsSync(activeFile)) return '';
    const { id } = JSON.parse(readFileSync(activeFile, 'utf8'));
    if (!SAFE_ID.test(String(id ?? ''))) return '';
    const profile = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
    const ws = String(profile?.workspace ?? '');
    return SAFE_ID.test(ws) ? ws : '';
  } catch {
    return '';
  }
}

/**
 * Every path that belongs to one workspace.
 *
 * @param {string} root project root
 * @param {string} [workspaceId] defaults to the active profile's
 * @returns {{id: string, db: string, resume: string, resumeDir: string, history: string,
 *            dataDir: string, applicationsDir: string}}
 */
export function workspacePaths(root, workspaceId = activeWorkspaceId(root)) {
  const id = SAFE_ID.test(String(workspaceId ?? '')) ? String(workspaceId) : '';
  if (!id) {
    return {
      id: '',
      db: join(root, 'data', 'applied_jobs.db'),
      resume: join(root, 'resumes', 'base', 'MASTER_RESUME.docx'),
      resumeDir: join(root, 'resumes', 'base'),
      history: join(root, 'resumes', 'base', 'history'),
      dataDir: join(root, 'data'),
      applicationsDir: join(root, 'applications', 'output'),
    };
  }
  return {
    id,
    db: join(root, 'data', 'profiles', id, 'applied_jobs.db'),
    resume: join(root, 'resumes', 'profiles', id, 'MASTER_RESUME.docx'),
    resumeDir: join(root, 'resumes', 'profiles', id),
    history: join(root, 'resumes', 'profiles', id, 'history'),
    dataDir: join(root, 'data', 'profiles', id),
    applicationsDir: join(root, 'applications', 'profiles', id),
  };
}

/** The active person's master resume. */
export const masterResumeFile = (root) => workspacePaths(root).resume;
