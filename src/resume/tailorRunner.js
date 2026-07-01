/**
 * Resume tailoring runner (Node -> Python bridge).
 *
 * Invokes the deterministic Python tailor (src/resume/tailor_cli.py) in a child
 * process, passing the job + the keywords to emphasize, and returns a structured
 * result. The Python side opens the master resume READ-ONLY and writes a new
 * per-job DOCX under resumes/output — the master is never modified.
 *
 * Failure handling is graceful by design: if Python is unavailable, the master
 * resume is missing, or tailoring errors out, this returns a result with
 * `tailored: false`, a fallback to the master resume path, and a human-readable
 * warning. The caller can then attach that warning to the packet rather than
 * crashing the run.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Default master resume location (never overwritten). */
export function masterResumePath(root) {
  return join(root, 'resumes', 'base', 'MASTER_RESUME.docx');
}

/** Default tailored-output directory. */
export function outputDir(root) {
  return join(root, 'resumes', 'output');
}

/** Resolve the python executable (env override -> python -> python3). */
function pythonExe(env = process.env) {
  return env.PYTHON || env.PYTHON_EXECUTABLE || 'python';
}

/** Build the keyword set to emphasize from a score result. */
export function keywordsForJob(score = {}) {
  const matched = Array.isArray(score.matchedKeywords) ? score.matchedKeywords : [];
  const missing = Array.isArray(score.missingKeywords) ? score.missingKeywords : [];
  // De-dupe while preserving order; matched first (they are most relevant).
  const seen = new Set();
  const out = [];
  for (const kw of [...matched, ...missing]) {
    const key = String(kw).toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
  }
  return out;
}

/**
 * Flatten the scoring config's keyword vocabulary into one de-duplicated list.
 * This grounds the JD keyword tiering: the ATS report only tiers terms from this
 * known data-engineering vocabulary, so it never invents random words.
 * @param {object} [scoring] parsed config/scoring.json
 * @returns {string[]}
 */
export function vocabularyFromScoring(scoring = {}) {
  const kw = scoring.keywords ?? {};
  const seen = new Set();
  const out = [];
  for (const list of Object.values(kw)) {
    if (!Array.isArray(list)) continue;
    for (const term of list) {
      const key = String(term).toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(term);
    }
  }
  return out;
}

/**
 * Run the Python tailor for one job.
 *
 * @param {object} args
 * @param {object} args.job normalized job ({company, title, jdText})
 * @param {object} args.score scoreJob result (matched/missing keywords)
 * @param {object} args.config loadConfig bundle (uses config.root, humanizerPatterns)
 * @param {object} [args.options]
 * @param {boolean} [args.options.exportPdf=false] also export a PDF (best-effort)
 * @param {boolean} [args.options.addSummaryLine=false]
 * @param {object} [args.deps]
 * @param {Function} [args.deps.spawnImpl] override child_process.spawn (testing)
 * @param {NodeJS.ProcessEnv} [args.deps.env]
 * @param {number} [args.deps.timeoutMs=60000]
 * @returns {Promise<{
 *   tailored: boolean, output_path: string, pdf_path: string|null,
 *   audit: object|null, emphasized: number|null, summaryLine: string|null,
 *   warning: string|null, usedFallback: boolean
 * }>}
 */
export async function tailorResumeForJob({ job, score, config, options = {}, deps = {} } = {}) {
  const root = config.root;
  const master = masterResumePath(root);
  const fallback = {
    tailored: false,
    output_path: master,
    pdf_path: null,
    audit: null,
    emphasized: null,
    summaryLine: null,
    validation: null,
    atsReport: null,
    warning: null,
    usedFallback: true,
  };

  if (!existsSync(master)) {
    return { ...fallback, warning: `master resume not found at ${master}; cannot tailor` };
  }

  const request = {
    master_path: master,
    output_dir: options.outputDir ?? outputDir(root),
    output_filename: options.outputFilename ?? null,
    job: {
      company: job.company ?? '',
      title: job.title ?? '',
      jd_text: job.jdText ?? '',
    },
    keywords: keywordsForJob(score),
    // Vocabulary + ATS rules drive the deterministic ATS readiness report.
    vocabulary: vocabularyFromScoring(config.scoring),
    ats_config: config.atsResume ?? {},
    patterns: config.humanizerPatterns ?? {},
    add_summary_line: options.addSummaryLine === true,
    export_pdf: options.exportPdf === true,
  };

  let response;
  try {
    response = await invokePython(request, deps);
  } catch (err) {
    return { ...fallback, warning: `resume tailoring failed: ${err.message}` };
  }

  if (!response || response.ok !== true) {
    return { ...fallback, warning: `resume tailoring failed: ${response?.error ?? 'unknown error'}` };
  }

  return {
    tailored: true,
    output_path: response.output_path,
    pdf_path: response.pdf_path ?? null,
    audit: response.audit ?? null,
    emphasized: response.emphasized ?? null,
    summaryLine: response.summary_line ?? null,
    validation: response.validation ?? null,
    atsReport: response.ats_report ?? null,
    warning: null,
    usedFallback: false,
  };
}

/** Spawn the python CLI, feed it the request JSON, and parse its JSON reply. */
function invokePython(request, deps = {}) {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const env = deps.env ?? process.env;
  const timeoutMs = deps.timeoutMs ?? 60000;
  const script = scriptPath();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(pythonExe(env), [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error(`python tailor timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = stdout.trim();
      if (!text) {
        reject(new Error(`python tailor produced no output${stderr ? `: ${stderr.trim()}` : ''}`));
        return;
      }
      try {
        resolve(JSON.parse(lastJsonLine(text)));
      } catch (err) {
        reject(new Error(`could not parse python output: ${err.message}`));
      }
    });

    try {
      child.stdin?.write(JSON.stringify(request));
      child.stdin?.end();
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    }
  });
}

/** Absolute path to the python CLI script. */
function scriptPath() {
  return new URL('./tailor_cli.py', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

/** Tolerate banner/log lines: parse the last non-empty line as JSON. */
function lastJsonLine(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines[lines.length - 1];
}
