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

/** Env override names honoured for the interpreter, in priority order. */
export function pythonExe(env = process.env) {
  return env.PYTHON || env.PYTHON_EXECUTABLE || 'python';
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
