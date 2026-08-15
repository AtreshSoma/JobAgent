/**
 * The Node <-> Python pipe must be UTF-8 on both ends.
 *
 * Measured on a real Windows machine before this was fixed: CPython picked its
 * stdio encoding from the OS locale (cp1252), so a path Node sent as UTF-8 came
 * out mangled at the other end —
 *
 *     node sent  : .../applications/output/84.51°/...
 *     python got : .../applications/output/84.51Â°/...
 *
 * These messages carry FILE PATHS, so that is not cosmetic. The tailor created
 * the mangled directory and wrote the resume into it, leaving the packet JSON
 * (written by Node, with the name right) in a different folder; and the PDF
 * preview then reported "missing docx" for a file Node had just confirmed
 * existed. A regression here silently splits an application packet in two.
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pythonEnv, pythonExe } from '../../src/resume/pythonEnv.js';
import { ensureResumePdf } from '../../src/resume/pdfPreview.js';

describe('pythonEnv', () => {
  it('forces UTF-8 stdio on the child', () => {
    const env = pythonEnv({ PATH: '/usr/bin' });
    expect(env.PYTHONUTF8).toBe('1');
    expect(env.PYTHONIOENCODING).toBe('utf-8');
  });

  it('keeps the rest of the parent environment', () => {
    expect(pythonEnv({ PATH: '/usr/bin', PYTHON: 'py' })).toMatchObject({ PATH: '/usr/bin', PYTHON: 'py' });
  });

  it('does not overrule an encoding the operator set deliberately', () => {
    const env = pythonEnv({ PYTHONIOENCODING: 'latin-1', PYTHONUTF8: '0' });
    expect(env.PYTHONIOENCODING).toBe('latin-1');
    expect(env.PYTHONUTF8).toBe('0');
  });

  it('resolves the interpreter from the usual overrides', () => {
    expect(pythonExe({})).toBe('python');
    expect(pythonExe({ PYTHON: 'python3.12' })).toBe('python3.12');
    expect(pythonExe({ PYTHON_EXECUTABLE: '/opt/py/bin/python' })).toBe('/opt/py/bin/python');
  });
});

describe('ensureResumePdf', () => {
  /** A stub child that reports success and records how it was spawned. */
  const stubChild = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      written: '',
      write(s) { this.written += s; },
      end() {
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(`${JSON.stringify({ exported: true, pdf_path: '/tmp/x.pdf', pages: 1 })}\n`));
          child.emit('close', 0);
        });
      },
    };
    return child;
  };

  /** A real file, because ensureResumePdf refuses to spawn without one. */
  const realDocx = () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobagent-enc-'));
    const path = join(dir, 'r.docx');
    writeFileSync(path, 'x');
    return path;
  };

  it('spawns the converter with a UTF-8 environment', async () => {
    let seen = null;
    const spawnImpl = (_cmd, _args, options) => { seen = options; return stubChild(); };
    await ensureResumePdf(realDocx(), { spawnImpl, env: { PATH: '/usr/bin' } });
    expect(seen.env.PYTHONUTF8).toBe('1');
    expect(seen.env.PYTHONIOENCODING).toBe('utf-8');
  });

  it('sends a non-ASCII path through verbatim', async () => {
    // The exact shape that broke: a degree sign in the employer name.
    let child = null;
    const spawnImpl = () => { child = stubChild(); return child; };
    const docx = realDocx();
    await ensureResumePdf(docx, { spawnImpl, env: {} });
    expect(JSON.parse(child.stdin.written).docx_path).toBe(docx);
  });

  it('does not spawn at all when the docx is missing', async () => {
    let spawned = false;
    const spawnImpl = () => { spawned = true; return stubChild(); };
    const r = await ensureResumePdf('/no/such/84.51°/r.docx', { spawnImpl, env: {} });
    expect(spawned).toBe(false);
    expect(r.exported).toBe(false);
  });
});
