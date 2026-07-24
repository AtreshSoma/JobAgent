/** Best-effort, on-demand PDF generation for dashboard resume previews. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function pythonExe(env = process.env) {
  return env.PYTHON || env.PYTHON_EXECUTABLE || 'python';
}

function lastJsonLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.trim());
  return lines[lines.length - 1] ?? '';
}

/**
 * Convert a generated tailored DOCX to a sibling PDF. Existing PDFs are reused.
 * The caller is responsible for validating that both paths are workspace-local.
 */
export function ensureResumePdf(docxPath, { spawnImpl = spawn, env = process.env, timeoutMs = 60000 } = {}) {
  if (!docxPath || !existsSync(docxPath)) {
    return Promise.resolve({ exported: false, pdfPath: null, reason: 'tailored DOCX was not found' });
  }
  const script = fileURLToPath(new URL('./pdf_export_cli.py', import.meta.url));
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(pythonExe(env), [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ exported: false, pdfPath: null, reason: `preview converter could not start: ${err.message}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      finish({ exported: false, pdfPath: null, reason: `preview conversion timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => finish({ exported: false, pdfPath: null, reason: `preview conversion failed: ${err.message}` }));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(lastJsonLine(stdout));
        finish({
          exported: parsed.exported === true,
          pdfPath: parsed.pdf_path ?? null,
          reason: parsed.reason ?? (parsed.exported ? 'ok' : stderr.trim() || 'preview conversion failed'),
        });
      } catch (err) {
        finish({ exported: false, pdfPath: null, reason: `preview converter returned invalid output: ${err.message}` });
      }
    });
    try {
      child.stdin?.write(JSON.stringify({ docx_path: docxPath }));
      child.stdin?.end();
    } catch (err) {
      finish({ exported: false, pdfPath: null, reason: `preview request failed: ${err.message}` });
    }
  });
}
