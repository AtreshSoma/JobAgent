/**
 * `npm run learn` serves only its own directory and fails politely.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveInside } from '../../interview-prep/serve.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const root = join(sep, 'srv', 'learn');

describe('resolveInside (path containment)', () => {
  it('allows files inside the root', () => {
    expect(resolveInside(root, '/index.html')).toBe(join(root, 'index.html'));
    expect(resolveInside(root, '/a/b.css')).toBe(join(root, 'a', 'b.css'));
  });

  it('rejects traversal out of the root', () => {
    expect(resolveInside(root, '/../../etc/passwd')).toBeNull();
  });

  it('rejects a sibling directory that merely shares the prefix', () => {
    // startsWith(root) alone accepted /srv/learn-private/…
    expect(resolveInside(root, '/../learn-private/secret.txt')).toBeNull();
  });
});

describe('build-pdf cover', () => {
  it('takes the owner name from PREP_PDF_NAME / --name instead of hardcoding one', () => {
    const src = readFileSync(join(REPO, 'interview-prep', 'build-pdf.mjs'), 'utf8');
    expect(src).toMatch(/process\.env\.PREP_PDF_NAME/);
    // The cover-name element is only ever the templated value.
    expect(src).not.toMatch(/class="cover-name">[A-Za-z]/);
  });
});

describe('port already in use', () => {
  it('exits 1 with a friendly message instead of a stack trace', async () => {
    const blocker = createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const port = blocker.address().port;
    try {
      const child = spawn(process.execPath, [join(REPO, 'interview-prep', 'serve.mjs')], {
        env: { ...process.env, LEARN_PORT: String(port), LEARN_NO_OPEN: '1' },
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      const code = await new Promise((r) => child.on('exit', r));
      expect(code).toBe(1);
      expect(stderr).toMatch(/already in use/);
      expect(stderr).not.toMatch(/at Server\./);
    } finally {
      blocker.close();
    }
  }, 15000);
});
