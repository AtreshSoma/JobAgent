/**
 * How this project talks to its Python helpers.
 *
 * WHY THIS EXISTS
 *
 * Node and Python exchange JSON over stdin/stdout. Node writes and reads that
 * pipe as UTF-8 (the default for `stream.write(string)` and `buffer.toString()`),
 * but CPython picks its stdio encoding from the OS locale — and on a Windows
 * machine that is the ANSI code page, not UTF-8. Measured on this machine:
 *
 *     python got : "…/applications/output/84.51Â°/…"
 *     node sent  : "…/applications/output/84.51°/…"
 *     encodings  : stdin=cp1252 stdout=cp1252 fs=utf-8
 *
 * Every byte above U+007F is corrupted in transit, in BOTH directions. That is
 * not a cosmetic problem, because these messages carry FILE PATHS:
 *
 *   - the tailor received a mangled output directory and dutifully created it,
 *     so "84.51°" resumes were written to a real directory named "84.51Â°"
 *     while their packet JSON and cover letter — written by Node — landed in
 *     the correctly-named one. One job, two directories, neither complete.
 *   - the PDF preview then passed the CORRECT path down, Python looked for the
 *     mangled one, and reported "missing docx" for a file Node had just
 *     confirmed exists.
 *
 * Note `fs=utf-8`: Python's *filesystem* encoding was already right (PEP 529).
 * Only the pipe was wrong, which is why the failure looked like a filesystem
 * problem and was not one.
 *
 * THE FIX
 *
 * `PYTHONUTF8=1` turns on Python's UTF-8 Mode (3.7+), which makes stdio and the
 * filesystem encoding UTF-8 regardless of locale. `PYTHONIOENCODING=utf-8` says
 * the same thing about stdio specifically and covers a Python built without
 * UTF-8 Mode. Neither changes anything on a platform that was already UTF-8, so
 * this is safe everywhere rather than a Windows special case.
 */

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root (src/resume/ -> ../..). */
export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The project virtualenv's interpreter for this platform. */
export function venvPython(root = PROJECT_ROOT, platform = process.platform) {
  return platform === 'win32'
    ? join(root, '.venv', 'Scripts', 'python.exe')
    : join(root, '.venv', 'bin', 'python');
}

/**
 * Interpreters to try, in priority order:
 *   1. `PYTHON` / `PYTHON_EXECUTABLE` — an explicit choice always wins;
 *   2. `<root>/.venv` — where `requirements.txt` was installed;
 *   3. `python3`, then `python` from PATH.
 *
 * WHY. Every caller used `PYTHON || 'python'`. On macOS there is no `python`
 * on PATH at all (only `python3`), and where there is one it is usually a
 * system interpreter WITHOUT python-docx — while the project's own `.venv`,
 * which has it, was never consulted. Tailoring then "failed" and silently
 * fell back to the untailored master resume. Doctor probed a different list
 * again, so it could report a healthy Python the tailor never used.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{root?: string, platform?: string, exists?: (p: string) => boolean}} [options]
 * @returns {string[]}
 */
export function pythonCandidates(env = process.env, { root = PROJECT_ROOT, platform = process.platform, exists = existsSync } = {}) {
  const fromEnv = env?.PYTHON || env?.PYTHON_EXECUTABLE;
  if (fromEnv) return [fromEnv];
  const out = [];
  const venv = root ? venvPython(root, platform) : null;
  if (venv && exists(venv)) out.push(venv);
  out.push(...pathNames(platform));
  return out;
}

/**
 * PATH names to try, in order. On Windows `python` first: the python.org
 * installer provides python.exe, not python3.exe, while a fresh Windows puts a
 * Microsoft Store STUB named python3.exe on PATH (WindowsApps) that only
 * prints "Python was not found" — picking it silently disabled tailoring.
 */
function pathNames(platform) {
  return platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
}

/** Is `name` an executable file somewhere on PATH? (no spawn) */
function onPath(name, env, platform, exists) {
  const dirs = String(env?.PATH ?? env?.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const exts = platform === 'win32'
    ? String(env?.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean).concat([''])
    : [''];
  return dirs
    // The App Execution Alias stubs are not interpreters (see pathNames).
    .filter((dir) => !(platform === 'win32' && /[\\/]WindowsApps[\\/]?$/i.test(dir)))
    .some((dir) => exts.some((ext) => exists(join(dir, `${name}${ext.toLowerCase()}`)) || exists(join(dir, `${name}${ext}`))));
}

/**
 * The ONE interpreter every Python call in the project uses (tailor, PDF
 * preview, regenerate script, doctor). See `pythonCandidates` for the order.
 * A PATH name is returned only when it is actually on PATH; with nothing
 * found it returns `python3` (`python` on Windows) so the spawn error names a
 * real interpreter.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{root?: string, platform?: string, exists?: (p: string) => boolean}} [options]
 * @returns {string}
 */
export function pythonExe(env = process.env, { root = PROJECT_ROOT, platform = process.platform, exists = existsSync } = {}) {
  const candidates = pythonCandidates(env, { root, platform, exists });
  const [first] = candidates;
  if (env?.PYTHON || env?.PYTHON_EXECUTABLE) return first;
  const venv = root ? venvPython(root, platform) : null;
  if (first === venv) return venv;
  for (const name of pathNames(platform)) {
    if (onPath(name, env, platform, exists)) return name;
  }
  return platform === 'win32' ? 'python' : 'python3';
}

/** Minimum Python the project supports. */
export const MIN_PYTHON = Object.freeze([3, 12]);

/**
 * Parse `python --version` output ("Python 3.12.4") and compare to MIN_PYTHON.
 * @param {string} text
 * @returns {{version: string|null, ok: boolean}}
 */
export function checkPythonVersion(text) {
  const m = /Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(String(text ?? ''));
  if (!m) return { version: null, ok: false };
  const [major, minor] = [Number(m[1]), Number(m[2])];
  const ok = major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1]);
  return { version: `${m[1]}.${m[2]}${m[3] ? `.${m[3]}` : ''}`, ok };
}

/**
 * The parent env plus the settings that make the child's stdio UTF-8.
 *
 * Caller-supplied values win: if someone has deliberately set PYTHONIOENCODING
 * we do not overrule them, we only supply a default where there is none.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function pythonEnv(env = process.env) {
  return {
    ...env,
    PYTHONUTF8: env.PYTHONUTF8 ?? '1',
    PYTHONIOENCODING: env.PYTHONIOENCODING ?? 'utf-8',
  };
}

/**
 * Seconds the Python side may spend converting ONE document to PDF: Word
 * (docx2pdf) and then LibreOffice, 90 s each, both hard-limited in
 * pdfExport.py. Node's own timeouts are derived from this so Node never kills
 * a child that is still inside a conversion Python itself would have timed
 * out and reported cleanly. (Node used to give the whole tailor 60 s while
 * LibreOffice alone was allowed 120 s.)
 */
export const PYTHON_PDF_BUDGET_SECONDS = 180;

/** Node-side timeout for a Python call, with head-room over its PDF budget. */
export function pythonTimeoutMs({ exportPdf = false, baseMs = 60_000 } = {}) {
  return exportPdf ? baseMs + (PYTHON_PDF_BUDGET_SECONDS + 30) * 1000 : baseMs;
}

/**
 * spawn() options for a Python helper: piped stdio, the UTF-8 env, and on
 * POSIX its own process group so a timeout can kill the whole tree (the
 * interpreter AND the soffice / Word helper it launched).
 */
export function pythonSpawnOptions(env = process.env, platform = process.platform) {
  return {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: pythonEnv(env),
    ...(platform === 'win32' ? { windowsHide: true } : { detached: true }),
  };
}

/**
 * Kill a Python helper and everything it started.
 *
 * `child.kill()` signalled only the interpreter; a LibreOffice it had spawned
 * kept running (and kept its profile lock) after every timeout. POSIX: the
 * child leads its own group (see pythonSpawnOptions), so signal `-pid`.
 * Windows: `taskkill /T /F`.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {object} [deps]
 */
export function killProcessTree(child, {
  platform = process.platform, killImpl = process.kill.bind(process), spawnImpl,
} = {}) {
  if (!child) return;
  try {
    if (platform === 'win32' && child.pid && spawnImpl) {
      spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    }
    if (child.pid && platform !== 'win32') {
      killImpl(-child.pid, 'SIGKILL');
      return;
    }
  } catch { /* fall back to the direct kill */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}
